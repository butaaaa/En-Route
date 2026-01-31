/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EN-ROUTE BACKEND - API COMPLÈTE
 *  Location véhicules BTP, Agricole, Logistique - Bénin
 * ═══════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const httpServer = createServer(app);

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer pour upload temporaire
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ═══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3000', 'https://en-route.vercel.app'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // 100 requêtes par IP
});
app.use('/api/', limiter);

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO - TEMPS RÉEL
// ═══════════════════════════════════════════════════════════════════════════

const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'https://en-route.vercel.app'],
    methods: ['GET', 'POST']
  }
});

// Stockage positions en mémoire (Redis en production)
const driverPositions = new Map();
const activeOrders = new Map();

io.on('connection', (socket) => {
  console.log(`📱 Client connecté: ${socket.id}`);

  // Chauffeur envoie sa position
  socket.on('driver:location', async (data) => {
    const { driverId, lat, lon, speed, heading, battery, isOnline } = data;
    
    const position = {
      lat,
      lon,
      speed: speed || 0,
      heading: heading || 0,
      battery: battery || 100,
      isOnline: isOnline !== false,
      lastUpdate: new Date(),
      socketId: socket.id
    };
    
    driverPositions.set(driverId, position);
    
    // Mise à jour MongoDB (moins fréquent pour économiser)
    if (Math.random() < 0.1) { // 10% des updates
      await User.findByIdAndUpdate(driverId, {
        'location.lat': lat,
        'location.lon': lon,
        'location.lastUpdate': new Date()
      });
    }
    
    // Broadcast aux clients qui regardent la carte
    socket.broadcast.emit('drivers:update', {
      driverId,
      ...position
    });
    
    // Si course active, envoyer au client concerné
    const activeOrder = [...activeOrders.values()].find(o => o.driverId === driverId);
    if (activeOrder) {
      io.to(activeOrder.clientSocketId).emit('order:driver_location', {
        orderId: activeOrder.orderId,
        lat,
        lon,
        speed,
        heading
      });
    }
  });

  // Client suit une commande
  socket.on('order:track', (data) => {
    const { orderId, clientId } = data;
    const order = activeOrders.get(orderId);
    if (order) {
      order.clientSocketId = socket.id;
      activeOrders.set(orderId, order);
    }
  });

  // Chauffeur rejoint une commande
  socket.on('driver:accept_order', (data) => {
    const { orderId, driverId } = data;
    activeOrders.set(orderId, {
      orderId,
      driverId,
      driverSocketId: socket.id,
      clientSocketId: null,
      status: 'accepted'
    });
  });

  // Chat temps réel
  socket.on('chat:message', async (data) => {
    const { orderId, senderId, senderType, message, type } = data;
    
    // Sauvegarder en DB
    const order = await Order.findById(orderId);
    if (order) {
      order.messages.push({
        senderId,
        senderType,
        message,
        type: type || 'text',
        timestamp: new Date()
      });
      await order.save();
    }
    
    // Envoyer à l'autre partie
    const activeOrder = activeOrders.get(orderId);
    if (activeOrder) {
      const targetSocket = senderType === 'client' 
        ? activeOrder.driverSocketId 
        : activeOrder.clientSocketId;
      
      if (targetSocket) {
        io.to(targetSocket).emit('chat:new_message', {
          orderId,
          senderId,
          senderType,
          message,
          type,
          timestamp: new Date()
        });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`📴 Client déconnecté: ${socket.id}`);
    
    // Marquer chauffeur hors ligne
    for (const [driverId, pos] of driverPositions.entries()) {
      if (pos.socketId === socket.id) {
        pos.isOnline = false;
        driverPositions.set(driverId, pos);
        io.emit('drivers:update', { driverId, ...pos });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  MONGOOSE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

// --- USER SCHEMA ---
const userSchema = new mongoose.Schema({
  // Auth
  phone: { type: String, sparse: true },
  googleId: { type: String, sparse: true },
  email: { type: String, sparse: true },
  passwordHash: String,
  
  // Profile
  name: { type: String, required: true },
  photo: { type: String, default: '' },
  type: { 
    type: String, 
    enum: ['client', 'driver', 'admin'], 
    default: 'client' 
  },
  language: { type: String, enum: ['fr', 'en'], default: 'fr' },
  
  // Location
  location: {
    lat: Number,
    lon: Number,
    address: String,
    lastUpdate: Date
  },
  
  // Driver specific
  driverProfile: {
    isVerified: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    rating: { type: Number, default: 5.0 },
    totalTrips: { type: Number, default: 0 },
    totalKm: { type: Number, default: 0 },
    documents: {
      idCard: String,
      driverLicense: String,
      insurance: String
    },
    
    // Wallet
    wallet: {
      balance: { type: Number, default: 0 },
      currency: { type: String, default: 'XOF' }
    }
  },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastLoginAt: Date
}, { timestamps: true });

userSchema.index({ phone: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ 'location.lat': 1, 'location.lon': 1 });
userSchema.index({ type: 1, 'driverProfile.isOnline': 1 });

const User = mongoose.model('User', userSchema);

// --- VEHICLE SCHEMA ---
const vehicleSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Catégorie
  category: {
    type: String,
    enum: ['btp', 'agricole', 'transport', 'logistique'],
    required: true
  },
  
  // Type de véhicule
  type: {
    type: String,
    enum: [
      // BTP
      'benne', 'camion_grue', 'pelleteuse', 'bulldozer', 'chargeuse', 'compacteur',
      // Agricole
      'tracteur', 'moissonneuse', 'remorque_agricole', 'citerne_eau',
      // Transport
      'camion_plateau', 'camion_bache', 'camion_frigo', 'porte_conteneur',
      // Logistique
      'fourgon', 'camionnette', 'semi_remorque'
    ],
    required: true
  },
  
  // Détails véhicule
  brand: { type: String, required: true },
  model: String,
  year: Number,
  plateNumber: { type: String, required: true },
  color: String,
  
  // Spécifications
  specs: {
    capacity_m3: Number,      // Pour bennes
    capacity_tons: Number,    // Tonnage
    capacity_kg: Number,      // Capacité en kg
    length_m: Number,
    width_m: Number,
    height_m: Number,
    hasAC: { type: Boolean, default: false },
    hasTarpaulin: { type: Boolean, default: false }, // Bâche
    isRefrigerated: { type: Boolean, default: false }
  },
  
  // Photos
  photos: [String],
  
  // Tarification
  pricing: {
    pricePerKm: Number,        // Prix au km
    pricePerHour: Number,      // Prix à l'heure
    pricePerDay: Number,       // Prix à la journée
    pricePerM3: Number,        // Prix au m³ (pour matériaux)
    minimumPrice: Number,      // Prix minimum
    currency: { type: String, default: 'XOF' }
  },
  
  // État
  isAvailable: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },
  
  // Stats
  totalTrips: { type: Number, default: 0 },
  rating: { type: Number, default: 5.0 }
  
}, { timestamps: true });

vehicleSchema.index({ category: 1, type: 1 });
vehicleSchema.index({ driverId: 1 });
vehicleSchema.index({ isAvailable: 1 });

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// --- ORDER SCHEMA ---
const orderSchema = new mongoose.Schema({
  // Numéro de commande
  orderNumber: { type: String, unique: true },
  
  // Parties
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  
  // Status
  status: {
    type: String,
    enum: [
      'pending',      // En attente de chauffeur
      'accepted',     // Chauffeur accepté
      'driver_coming', // Chauffeur en route
      'loading',      // Chargement en cours
      'in_transit',   // En transit
      'unloading',    // Déchargement
      'completed',    // Terminé
      'cancelled',    // Annulé
      'disputed'      // Litige
    ],
    default: 'pending'
  },
  
  // Type de service
  serviceType: {
    type: String,
    enum: ['transport', 'location_heure', 'location_jour'],
    required: true
  },
  
  // Lieux
  pickup: {
    address: { type: String, required: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    instructions: String,
    contactName: String,
    contactPhone: String
  },
  
  dropoff: {
    address: String,
    lat: Number,
    lon: Number,
    instructions: String,
    contactName: String,
    contactPhone: String
  },
  
  // Cargaison
  cargo: {
    type: String,  // sable, gravier, ciment, récolte, etc.
    description: String,
    estimatedVolume_m3: Number,
    estimatedWeight_kg: Number,
    confirmedVolume_m3: Number,
    requiresVerification: { type: Boolean, default: true }
  },
  
  // Photos vérification
  verification: {
    loadingPhotos: [String],
    unloadingPhotos: [String],
    loadingConfirmedAt: Date,
    unloadingConfirmedAt: Date,
    clientValidated: { type: Boolean, default: false }
  },
  
  // Suivi GPS
  tracking: [{
    lat: Number,
    lon: Number,
    speed: Number,
    timestamp: Date
  }],
  
  // Distance et durée
  distance: {
    estimated_km: Number,
    actual_km: Number
  },
  
  duration: {
    estimated_minutes: Number,
    actual_minutes: Number,
    rental_hours: Number,
    rental_days: Number
  },
  
  // Paiement
  payment: {
    method: {
      type: String,
      enum: ['cash', 'mobile_money', 'agency'],
      required: true
    },
    mobileMoneyProvider: String, // mtn, orange, moov
    
    amount: { type: Number, required: true },
    currency: { type: String, default: 'XOF' },
    
    platformFee: Number,      // Commission En-Route
    driverShare: Number,      // Part chauffeur
    
    status: {
      type: String,
      enum: ['pending', 'proof_submitted', 'confirmed', 'paid_to_driver', 'refunded'],
      default: 'pending'
    },
    
    // Preuve de paiement
    proofImage: String,
    proofTransactionId: String,
    proofSubmittedAt: Date,
    confirmedAt: Date,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  
  // Messages
  messages: [{
    senderId: mongoose.Schema.Types.ObjectId,
    senderType: { type: String, enum: ['client', 'driver', 'system', 'bot'] },
    message: String,
    type: { type: String, enum: ['text', 'image', 'location', 'system'], default: 'text' },
    timestamp: { type: Date, default: Date.now }
  }],
  
  // Notes et avis
  rating: {
    clientToDriver: Number,
    driverToClient: Number,
    clientComment: String,
    driverComment: String
  },
  
  // Dates
  scheduledAt: Date,
  acceptedAt: Date,
  startedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  cancelReason: String
  
}, { timestamps: true });

orderSchema.index({ clientId: 1, status: 1 });
orderSchema.index({ driverId: 1, status: 1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ orderNumber: 1 });

// Générer numéro de commande
orderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await Order.countDocuments();
    const date = new Date();
    const year = date.getFullYear();
    const num = String(count + 1).padStart(5, '0');
    this.orderNumber = `ER-${year}-${num}`;
  }
  next();
});

const Order = mongoose.model('Order', orderSchema);

// --- WALLET TRANSACTION SCHEMA ---
const walletTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  type: {
    type: String,
    enum: ['recharge', 'commission', 'withdrawal', 'bonus', 'refund'],
    required: true
  },
  
  amount: { type: Number, required: true },
  currency: { type: String, default: 'XOF' },
  
  // Pour recharge
  mobileMoneyProvider: String,
  proofImage: String,
  transactionId: String,
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected'],
    default: 'pending'
  },
  
  // Lié à une commande
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  
  // Admin qui a confirmé
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  confirmedAt: Date,
  
  note: String
  
}, { timestamps: true });

walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ status: 1 });

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// Générer JWT
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user._id, 
      type: user.type,
      phone: user.phone 
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
};

// Middleware Auth
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: { fr: 'Token requis', en: 'Token required' }
      });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: { fr: 'Utilisateur non trouvé', en: 'User not found' }
      });
    }
    
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      message: { fr: 'Token invalide', en: 'Invalid token' }
    });
  }
};

// Middleware Admin
const adminMiddleware = (req, res, next) => {
  if (req.user.type !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      message: { fr: 'Accès admin requis', en: 'Admin access required' }
    });
  }
  next();
};

// Upload vers Cloudinary
const uploadToCloudinary = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { 
        folder: `en-route/${folder}`,
        resource_type: 'auto'
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    ).end(buffer);
  });
};

// Calculer distance (Haversine)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Rayon Terre en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES - AUTH
// ═══════════════════════════════════════════════════════════════════════════

// Inscription/Connexion par téléphone (simple, sans OTP)
app.post('/api/auth/phone', async (req, res) => {
  try {
    const { phone, name } = req.body;
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: { fr: 'Numéro de téléphone requis', en: 'Phone number required' }
      });
    }
    
    let user = await User.findOne({ phone });
    
    if (!user) {
      // Nouveau compte
      if (!name) {
        return res.status(400).json({
          success: false,
          message: { fr: 'Nom requis pour inscription', en: 'Name required for signup' },
          needsRegistration: true
        });
      }
      
      user = new User({
        phone,
        name,
        type: 'client'
      });
      await user.save();
    }
    
    user.lastLoginAt = new Date();
    await user.save();
    
    const token = generateToken(user);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        type: user.type,
        photo: user.photo,
        language: user.language
      }
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Connexion Google
app.post('/api/auth/google', async (req, res) => {
  try {
    const { googleId, email, name, photo } = req.body;
    
    if (!googleId || !email) {
      return res.status(400).json({
        success: false,
        message: { fr: 'Données Google requises', en: 'Google data required' }
      });
    }
    
    let user = await User.findOne({ 
      $or: [{ googleId }, { email }] 
    });
    
    if (!user) {
      user = new User({
        googleId,
        email,
        name,
        photo,
        type: 'client'
      });
    } else {
      user.googleId = googleId;
      if (photo) user.photo = photo;
    }
    
    user.lastLoginAt = new Date();
    await user.save();
    
    const token = generateToken(user);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        type: user.type,
        photo: user.photo,
        language: user.language
      }
    });
    
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Profil utilisateur
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      phone: req.user.phone,
      email: req.user.email,
      type: req.user.type,
      photo: req.user.photo,
      language: req.user.language,
      driverProfile: req.user.type === 'driver' ? req.user.driverProfile : null
    }
  });
});

// Mise à jour profil
app.put('/api/auth/profile', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { name, language } = req.body;
    
    if (name) req.user.name = name;
    if (language) req.user.language = language;
    
    if (req.file) {
      const photoUrl = await uploadToCloudinary(req.file.buffer, 'profiles');
      req.user.photo = photoUrl;
    }
    
    await req.user.save();
    
    res.json({
      success: true,
      user: {
        id: req.user._id,
        name: req.user.name,
        photo: req.user.photo,
        language: req.user.language
      }
    });
    
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES - VEHICLES
// ═══════════════════════════════════════════════════════════════════════════

// Liste des catégories et types
app.get('/api/vehicles/categories', (req, res) => {
  res.json({
    success: true,
    categories: [
      {
        id: 'btp',
        name: { fr: 'BTP & Construction', en: 'Construction' },
        icon: '🏗️',
        types: [
          { id: 'benne', name: { fr: 'Camion Benne', en: 'Dump Truck' }, icon: '🚛' },
          { id: 'camion_grue', name: { fr: 'Camion Grue', en: 'Crane Truck' }, icon: '🏗️' },
          { id: 'pelleteuse', name: { fr: 'Pelleteuse', en: 'Excavator' }, icon: '⛏️' },
          { id: 'bulldozer', name: { fr: 'Bulldozer', en: 'Bulldozer' }, icon: '🚜' },
          { id: 'chargeuse', name: { fr: 'Chargeuse', en: 'Loader' }, icon: '🚜' },
          { id: 'compacteur', name: { fr: 'Compacteur', en: 'Compactor' }, icon: '🛞' }
        ]
      },
      {
        id: 'agricole',
        name: { fr: 'Agricole', en: 'Agricultural' },
        icon: '🌾',
        types: [
          { id: 'tracteur', name: { fr: 'Tracteur', en: 'Tractor' }, icon: '🚜' },
          { id: 'moissonneuse', name: { fr: 'Moissonneuse', en: 'Harvester' }, icon: '🌾' },
          { id: 'remorque_agricole', name: { fr: 'Remorque Agricole', en: 'Farm Trailer' }, icon: '🚛' },
          { id: 'citerne_eau', name: { fr: 'Citerne à Eau', en: 'Water Tank' }, icon: '💧' }
        ]
      },
      {
        id: 'transport',
        name: { fr: 'Transport', en: 'Transport' },
        icon: '🚚',
        types: [
          { id: 'camion_plateau', name: { fr: 'Camion Plateau', en: 'Flatbed Truck' }, icon: '🚛' },
          { id: 'camion_bache', name: { fr: 'Camion Bâché', en: 'Covered Truck' }, icon: '🚚' },
          { id: 'camion_frigo', name: { fr: 'Camion Frigo', en: 'Refrigerated Truck' }, icon: '🧊' },
          { id: 'porte_conteneur', name: { fr: 'Porte-Conteneur', en: 'Container Truck' }, icon: '📦' }
        ]
      },
      {
        id: 'logistique',
        name: { fr: 'Logistique', en: 'Logistics' },
        icon: '📦',
        types: [
          { id: 'fourgon', name: { fr: 'Fourgon', en: 'Van' }, icon: '🚐' },
          { id: 'camionnette', name: { fr: 'Camionnette', en: 'Pickup' }, icon: '🛻' },
          { id: 'semi_remorque', name: { fr: 'Semi-Remorque', en: 'Semi-Trailer' }, icon: '🚛' }
        ]
      }
    ]
  });
});

// Recherche véhicules à proximité
app.get('/api/vehicles/nearby', async (req, res) => {
  try {
    const { lat, lon, radius = 50, category, type } = req.query;
    
    // Récupérer véhicules disponibles
    const query = { isAvailable: true };
    if (category) query.category = category;
    if (type) query.type = type;
    
    const vehicles = await Vehicle.find(query)
      .populate('driverId', 'name photo driverProfile location')
      .lean();
    
    // Filtrer par distance et ajouter positions temps réel
    const vehiclesWithDistance = vehicles
      .map(v => {
        // Position temps réel ou dernière connue
        const driverPos = driverPositions.get(v.driverId._id.toString());
        const vehicleLat = driverPos?.lat || v.driverId.location?.lat;
        const vehicleLon = driverPos?.lon || v.driverId.location?.lon;
        
        if (!vehicleLat || !vehicleLon) return null;
        
        const distance = lat && lon 
          ? calculateDistance(parseFloat(lat), parseFloat(lon), vehicleLat, vehicleLon)
          : null;
        
        return {
          ...v,
          currentLocation: {
            lat: vehicleLat,
            lon: vehicleLon
          },
          isOnline: driverPos?.isOnline || false,
          distance: distance ? Math.round(distance * 10) / 10 : null
        };
      })
      .filter(v => v !== null)
      .filter(v => !radius || v.distance <= parseFloat(radius))
      .sort((a, b) => (a.distance || 999) - (b.distance || 999));
    
    res.json({
      success: true,
      count: vehiclesWithDistance.length,
      vehicles: vehiclesWithDistance
    });
    
  } catch (error) {
    console.error('Vehicles nearby error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Détails d'un véhicule
app.get('/api/vehicles/:id', async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .populate('driverId', 'name photo phone driverProfile createdAt');
    
    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Véhicule non trouvé', en: 'Vehicle not found' }
      });
    }
    
    // Position temps réel
    const driverPos = driverPositions.get(vehicle.driverId._id.toString());
    
    res.json({
      success: true,
      vehicle: {
        ...vehicle.toObject(),
        currentLocation: driverPos ? {
          lat: driverPos.lat,
          lon: driverPos.lon
        } : vehicle.driverId.location,
        isOnline: driverPos?.isOnline || false
      }
    });
    
  } catch (error) {
    console.error('Vehicle detail error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Créer véhicule (chauffeur)
app.post('/api/vehicles', authMiddleware, upload.array('photos', 5), async (req, res) => {
  try {
    const { 
      category, type, brand, model, year, plateNumber, color,
      capacity_m3, capacity_tons, hasAC, hasTarpaulin,
      pricePerKm, pricePerHour, pricePerDay, minimumPrice
    } = req.body;
    
    // Upload photos
    const photoUrls = [];
    if (req.files) {
      for (const file of req.files) {
        const url = await uploadToCloudinary(file.buffer, 'vehicles');
        photoUrls.push(url);
      }
    }
    
    const vehicle = new Vehicle({
      driverId: req.user._id,
      category,
      type,
      brand,
      model,
      year: parseInt(year),
      plateNumber,
      color,
      specs: {
        capacity_m3: parseFloat(capacity_m3) || null,
        capacity_tons: parseFloat(capacity_tons) || null,
        hasAC: hasAC === 'true',
        hasTarpaulin: hasTarpaulin === 'true'
      },
      photos: photoUrls,
      pricing: {
        pricePerKm: parseFloat(pricePerKm) || null,
        pricePerHour: parseFloat(pricePerHour) || null,
        pricePerDay: parseFloat(pricePerDay) || null,
        minimumPrice: parseFloat(minimumPrice) || 5000
      }
    });
    
    await vehicle.save();
    
    // Mettre à jour le type user en driver
    if (req.user.type === 'client') {
      req.user.type = 'driver';
      await req.user.save();
    }
    
    res.status(201).json({
      success: true,
      vehicle
    });
    
  } catch (error) {
    console.error('Create vehicle error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES - ORDERS
// ═══════════════════════════════════════════════════════════════════════════

// Instructions de paiement Mobile Money
app.get('/api/payment/instructions', (req, res) => {
  res.json({
    success: true,
    instructions: {
      fr: {
        title: "Instructions de paiement",
        steps: [
          "Choisissez votre opérateur Mobile Money",
          "Envoyez le montant au numéro indiqué",
          "Prenez une capture d'écran de la confirmation",
          "Téléchargez la preuve dans l'application",
          "Votre commande sera confirmée sous 5 minutes"
        ]
      },
      en: {
        title: "Payment Instructions",
        steps: [
          "Choose your Mobile Money provider",
          "Send the amount to the indicated number",
          "Take a screenshot of the confirmation",
          "Upload the proof in the app",
          "Your order will be confirmed within 5 minutes"
        ]
      }
    },
    providers: [
      {
        id: 'mtn',
        name: 'MTN MoMo',
        number: process.env.MTN_MOMO_NUMBER || '+229 97 00 00 00',
        logo: 'https://example.com/mtn-logo.png',
        color: '#FFCC00'
      },
      {
        id: 'moov',
        name: 'Moov Money',
        number: process.env.MOOV_MONEY_NUMBER || '+229 95 00 00 00',
        logo: 'https://example.com/moov-logo.png',
        color: '#0066B3'
      },
      {
        id: 'orange',
        name: 'Orange Money',
        number: process.env.ORANGE_MONEY_NUMBER || '+229 96 00 00 00',
        logo: 'https://example.com/orange-logo.png',
        color: '#FF6600'
      }
    ]
  });
});

// Créer une commande
app.post('/api/orders', authMiddleware, async (req, res) => {
  try {
    const {
      vehicleId,
      serviceType,
      pickup,
      dropoff,
      cargo,
      payment,
      scheduledAt
    } = req.body;
    
    // Vérifier véhicule
    const vehicle = await Vehicle.findById(vehicleId).populate('driverId');
    if (!vehicle || !vehicle.isAvailable) {
      return res.status(400).json({
        success: false,
        message: { fr: 'Véhicule non disponible', en: 'Vehicle not available' }
      });
    }
    
    // Calculer prix
    let amount = vehicle.pricing.minimumPrice || 5000;
    
    if (serviceType === 'transport' && pickup.lat && dropoff?.lat) {
      const distance = calculateDistance(pickup.lat, pickup.lon, dropoff.lat, dropoff.lon);
      amount = Math.max(amount, distance * (vehicle.pricing.pricePerKm || 500));
    }
    
    // Commission 15%
    const platformFee = Math.round(amount * 0.15);
    const driverShare = amount - platformFee;
    
    const order = new Order({
      clientId: req.user._id,
      driverId: vehicle.driverId._id,
      vehicleId,
      serviceType,
      pickup,
      dropoff,
      cargo,
      payment: {
        method: payment.method,
        mobileMoneyProvider: payment.mobileMoneyProvider,
        amount,
        platformFee,
        driverShare,
        status: 'pending'
      },
      distance: {
        estimated_km: pickup.lat && dropoff?.lat 
          ? calculateDistance(pickup.lat, pickup.lon, dropoff.lat, dropoff.lon)
          : null
      },
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null
    });
    
    await order.save();
    
    // Notifier le chauffeur via WebSocket
    const driverPos = driverPositions.get(vehicle.driverId._id.toString());
    if (driverPos?.socketId) {
      io.to(driverPos.socketId).emit('order:new', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        pickup: order.pickup,
        cargo: order.cargo,
        amount: order.payment.amount,
        driverShare: order.payment.driverShare
      });
    }
    
    res.status(201).json({
      success: true,
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        payment: order.payment,
        pickup: order.pickup,
        dropoff: order.dropoff
      }
    });
    
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Soumettre preuve de paiement
app.post('/api/orders/:id/payment-proof', authMiddleware, upload.single('proof'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Commande non trouvée', en: 'Order not found' }
      });
    }
    
    if (order.clientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: { fr: 'Non autorisé', en: 'Not authorized' }
      });
    }
    
    let proofUrl = null;
    if (req.file) {
      proofUrl = await uploadToCloudinary(req.file.buffer, 'payment-proofs');
    }
    
    const { transactionId } = req.body;
    
    order.payment.proofImage = proofUrl;
    order.payment.proofTransactionId = transactionId;
    order.payment.proofSubmittedAt = new Date();
    order.payment.status = 'proof_submitted';
    
    await order.save();
    
    // Notifier admins (à implémenter: notification push/email)
    console.log(`💰 Nouvelle preuve de paiement pour commande ${order.orderNumber}`);
    
    res.json({
      success: true,
      message: { 
        fr: 'Preuve envoyée, vérification en cours', 
        en: 'Proof submitted, verification in progress' 
      }
    });
    
  } catch (error) {
    console.error('Payment proof error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Historique commandes client
app.get('/api/orders/my', authMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
    const query = req.user.type === 'driver'
      ? { driverId: req.user._id }
      : { clientId: req.user._id };
    
    if (status) query.status = status;
    
    const orders = await Order.find(query)
      .populate('vehicleId', 'type brand photos')
      .populate('driverId', 'name photo phone')
      .populate('clientId', 'name photo phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Order.countDocuments(query);
    
    res.json({
      success: true,
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Orders list error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Détails commande
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('vehicleId')
      .populate('driverId', 'name photo phone driverProfile')
      .populate('clientId', 'name photo phone');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Commande non trouvée', en: 'Order not found' }
      });
    }
    
    // Vérifier accès
    const isClient = order.clientId._id.toString() === req.user._id.toString();
    const isDriver = order.driverId._id.toString() === req.user._id.toString();
    const isAdmin = req.user.type === 'admin';
    
    if (!isClient && !isDriver && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: { fr: 'Non autorisé', en: 'Not authorized' }
      });
    }
    
    res.json({
      success: true,
      order
    });
    
  } catch (error) {
    console.error('Order detail error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Chauffeur accepte/refuse commande
app.put('/api/orders/:id/respond', authMiddleware, async (req, res) => {
  try {
    const { accept } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order || order.driverId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: { fr: 'Non autorisé', en: 'Not authorized' }
      });
    }
    
    if (accept) {
      order.status = 'accepted';
      order.acceptedAt = new Date();
      
      // Notifier client
      io.emit(`order:${order._id}:status`, { status: 'accepted' });
    } else {
      order.status = 'cancelled';
      order.cancelledAt = new Date();
      order.cancelReason = 'Driver refused';
    }
    
    await order.save();
    
    res.json({
      success: true,
      order
    });
    
  } catch (error) {
    console.error('Order respond error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Mise à jour statut commande
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Commande non trouvée', en: 'Order not found' }
      });
    }
    
    const isDriver = order.driverId.toString() === req.user._id.toString();
    const isAdmin = req.user.type === 'admin';
    
    if (!isDriver && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: { fr: 'Non autorisé', en: 'Not authorized' }
      });
    }
    
    order.status = status;
    
    if (status === 'in_transit') order.startedAt = new Date();
    if (status === 'completed') {
      order.completedAt = new Date();
      
      // Calculer km réel si tracking disponible
      if (order.tracking.length > 1) {
        let totalKm = 0;
        for (let i = 1; i < order.tracking.length; i++) {
          totalKm += calculateDistance(
            order.tracking[i-1].lat,
            order.tracking[i-1].lon,
            order.tracking[i].lat,
            order.tracking[i].lon
          );
        }
        order.distance.actual_km = Math.round(totalKm * 10) / 10;
      }
      
      // Mettre à jour stats chauffeur
      await User.findByIdAndUpdate(order.driverId, {
        $inc: {
          'driverProfile.totalTrips': 1,
          'driverProfile.totalKm': order.distance.actual_km || order.distance.estimated_km || 0
        }
      });
    }
    
    await order.save();
    
    // Notifier via WebSocket
    io.emit(`order:${order._id}:status`, { status });
    
    res.json({
      success: true,
      order
    });
    
  } catch (error) {
    console.error('Order status update error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Upload photos vérification (chargement/déchargement)
app.post('/api/orders/:id/verification-photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { type } = req.body; // 'loading' ou 'unloading'
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Commande non trouvée', en: 'Order not found' }
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: { fr: 'Photo requise', en: 'Photo required' }
      });
    }
    
    const photoUrl = await uploadToCloudinary(req.file.buffer, 'verifications');
    
    if (type === 'loading') {
      order.verification.loadingPhotos.push(photoUrl);
      order.verification.loadingConfirmedAt = new Date();
    } else {
      order.verification.unloadingPhotos.push(photoUrl);
      order.verification.unloadingConfirmedAt = new Date();
    }
    
    await order.save();
    
    res.json({
      success: true,
      photoUrl,
      message: { 
        fr: 'Photo ajoutée', 
        en: 'Photo added' 
      }
    });
    
  } catch (error) {
    console.error('Verification photo error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES - WALLET (Chauffeur)
// ═══════════════════════════════════════════════════════════════════════════

// Solde wallet
app.get('/api/wallet', authMiddleware, async (req, res) => {
  if (req.user.type !== 'driver') {
    return res.status(403).json({
      success: false,
      message: { fr: 'Réservé aux chauffeurs', en: 'Drivers only' }
    });
  }
  
  const transactions = await WalletTransaction.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20);
  
  res.json({
    success: true,
    wallet: {
      balance: req.user.driverProfile.wallet.balance,
      currency: 'XOF'
    },
    transactions
  });
});

// Demande de recharge
app.post('/api/wallet/recharge', authMiddleware, upload.single('proof'), async (req, res) => {
  try {
    const { amount, provider, transactionId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: { fr: 'Preuve de paiement requise', en: 'Payment proof required' }
      });
    }
    
    const proofUrl = await uploadToCloudinary(req.file.buffer, 'wallet-proofs');
    
    const transaction = new WalletTransaction({
      userId: req.user._id,
      type: 'recharge',
      amount: parseFloat(amount),
      mobileMoneyProvider: provider,
      proofImage: proofUrl,
      transactionId,
      status: 'pending'
    });
    
    await transaction.save();
    
    res.json({
      success: true,
      message: { 
        fr: 'Demande envoyée, vérification en cours', 
        en: 'Request sent, verification in progress' 
      },
      transaction
    });
    
  } catch (error) {
    console.error('Wallet recharge error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  API ROUTES - ADMIN
// ═══════════════════════════════════════════════════════════════════════════

// Dashboard stats
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const [
      totalUsers,
      totalDrivers,
      totalVehicles,
      totalOrders,
      ordersToday,
      pendingPayments,
      revenueToday
    ] = await Promise.all([
      User.countDocuments({ type: 'client' }),
      User.countDocuments({ type: 'driver' }),
      Vehicle.countDocuments(),
      Order.countDocuments(),
      Order.countDocuments({ createdAt: { $gte: today } }),
      Order.countDocuments({ 'payment.status': 'proof_submitted' }),
      Order.aggregate([
        { 
          $match: { 
            completedAt: { $gte: today },
            'payment.status': 'confirmed'
          } 
        },
        { $group: { _id: null, total: { $sum: '$payment.platformFee' } } }
      ])
    ]);
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        totalDrivers,
        totalVehicles,
        totalOrders,
        ordersToday,
        pendingPayments,
        revenueToday: revenueToday[0]?.total || 0,
        onlineDrivers: [...driverPositions.values()].filter(p => p.isOnline).length
      }
    });
    
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Liste paiements en attente
app.get('/api/admin/pending-payments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ 'payment.status': 'proof_submitted' })
      .populate('clientId', 'name phone')
      .populate('driverId', 'name phone')
      .sort({ 'payment.proofSubmittedAt': 1 });
    
    const walletRecharges = await WalletTransaction.find({ status: 'pending' })
      .populate('userId', 'name phone');
    
    res.json({
      success: true,
      orderPayments: orders,
      walletRecharges
    });
    
  } catch (error) {
    console.error('Pending payments error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Confirmer paiement commande
app.post('/api/admin/confirm-payment/:orderId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Commande non trouvée', en: 'Order not found' }
      });
    }
    
    order.payment.status = 'confirmed';
    order.payment.confirmedAt = new Date();
    order.payment.confirmedBy = req.user._id;
    
    await order.save();
    
    // Notifier client et chauffeur
    io.emit(`order:${order._id}:payment`, { status: 'confirmed' });
    
    res.json({
      success: true,
      message: { fr: 'Paiement confirmé', en: 'Payment confirmed' }
    });
    
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// Confirmer recharge wallet
app.post('/api/admin/confirm-recharge/:transactionId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transaction = await WalletTransaction.findById(req.params.transactionId);
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: { fr: 'Transaction non trouvée', en: 'Transaction not found' }
      });
    }
    
    transaction.status = 'confirmed';
    transaction.confirmedAt = new Date();
    transaction.confirmedBy = req.user._id;
    await transaction.save();
    
    // Créditer le wallet
    await User.findByIdAndUpdate(transaction.userId, {
      $inc: { 'driverProfile.wallet.balance': transaction.amount }
    });
    
    res.json({
      success: true,
      message: { fr: 'Recharge confirmée', en: 'Recharge confirmed' }
    });
    
  } catch (error) {
    console.error('Confirm recharge error:', error);
    res.status(500).json({
      success: false,
      message: { fr: 'Erreur serveur', en: 'Server error' }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK & START
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    name: 'En-Route API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Connexion MongoDB et démarrage
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/enroute')
  .then(() => {
    console.log('✅ MongoDB connecté');
    
    httpServer.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     🚛  EN-ROUTE API SERVER  🚛                           ║
║                                                            ║
║     Port: ${PORT}                                            ║
║     Environment: ${process.env.NODE_ENV || 'development'}                       ║
║     MongoDB: Connecté ✅                                   ║
║     WebSocket: Actif ✅                                    ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
      `);
    });
  })
  .catch(err => {
    console.error('❌ Erreur MongoDB:', err);
    process.exit(1);
  });