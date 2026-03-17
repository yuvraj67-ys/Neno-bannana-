require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS === '*' ? '*' : process.env.ALLOWED_ORIGINS?.split(',') || [],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Multer config for memory storage (for ImgBB upload)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 32 * 1024 * 1024 }, // 32MB max (ImgBB limit)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Rate limiting simple implementation
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 30;
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  
  const requests = rateLimitMap.get(ip);
  const validRequests = requests.filter(time => now - time < windowMs);  
  if (validRequests.length >= maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  
  validRequests.push(now);
  rateLimitMap.set(ip, validRequests);
  next();
}

// Apply rate limit to API routes
const apiLimiter = rateLimit;

// ============ API ROUTES ============

// 📤 Upload image to ImgBB via backend
app.post('/api/upload-imgbb', apiLimiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const apiKey = req.body.key || process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'ImgBB API key is required' });
    }

    // Create form data for ImgBB
    const formData = new FormData();
    formData.append('image', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    formData.append('key', apiKey);
    formData.append('name', req.file.originalname);

    // Upload to ImgBB
    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: {
        ...formData.getHeaders(),
        'Content-Length': formData.getLengthSync()
      },
      timeout: 30000
    });

    if (response.data?.success) {
      res.json({
        success: true,
        data: {
          url: response.data.data.url,          display_url: response.data.data.display_url,
          id: response.data.data.id
        }
      });
    } else {
      throw new Error(response.data?.error?.message || 'ImgBB upload failed');
    }

  } catch (error) {
    console.error('ImgBB Upload Error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to upload image',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 🎨 Create AI processing job (Prexzy API)
app.get('/api/ai/create-job', apiLimiter, async (req, res) => {
  try {
    const { image, prompt, model = 'nanobanana2' } = req.query;

    if (!image || !prompt) {
      return res.status(400).json({ error: 'Image URL and prompt are required' });
    }

    const baseUrl = process.env.PREXZY_BASE_URL || 'https://apis.prexzyvilla.site/ai';
    const endpoint = `${baseUrl}/pixwith-${model}`;

    const response = await axios.get(endpoint, {
      params: { image, prompt },
      timeout: 30000,
      headers: { 'User-Agent': 'AI-Background-Changer/1.0' }
    });

    if (response.data?.status && response.data?.job_id) {
      res.json(response.data);
    } else {
      throw new Error(response.data?.message || 'Failed to create job');
    }

  } catch (error) {
    console.error('Create Job Error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to create AI job',
      details: error.response?.data?.message || error.message
    });
  }
});
// 🔍 Check AI job result
app.get('/api/ai/check-result', apiLimiter, async (req, res) => {
  try {
    const { job_id } = req.query;

    if (!job_id) {
      return res.status(400).json({ error: 'job_id is required' });
    }

    const baseUrl = process.env.PREXZY_BASE_URL || 'https://apis.prexzyvilla.site/ai';
    const response = await axios.get(`${baseUrl}/pixwith-result`, {
      params: { job_id },
      timeout: 30000
    });

    res.json(response.data);

  } catch (error) {
    console.error('Check Result Error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to check result',
      details: error.response?.data?.message || error.message
    });
  }
});

// 🔄 Combined endpoint: Upload + Process + Return Result
app.post('/api/ai/process', apiLimiter, upload.single('image'), async (req, res) => {
  try {
    const { prompt, model = 'nanobanana2', key } = req.body;
    const apiKey = key || process.env.IMGBB_API_KEY;

    if (!req.file || !prompt) {
      return res.status(400).json({ error: 'Image file and prompt are required' });
    }

    // Step 1: Upload to ImgBB
    const formData = new FormData();
    formData.append('image', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    formData.append('key', apiKey);

    const imgbbRes = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: { ...formData.getHeaders(), 'Content-Length': formData.getLengthSync() },
      timeout: 30000
    });

    if (!imgbbRes.data?.success) {      throw new Error('ImgBB upload failed');
    }

    const imageUrl = imgbbRes.data.data.url;

    // Step 2: Create AI job
    const prexzyBaseUrl = process.env.PREXZY_BASE_URL || 'https://apis.prexzyvilla.site/ai';
    const jobRes = await axios.get(`${prexzyBaseUrl}/pixwith-${model}`, {
      params: { image: imageUrl, prompt },
      timeout: 30000
    });

    if (!jobRes.data?.job_id) {
      throw new Error(jobRes.data?.message || 'Failed to create job');
    }

    const jobId = jobRes.data.job_id;

    // Step 3: Poll for result (with timeout)
    const maxAttempts = 40;
    const pollInterval = 3000;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
      const resultRes = await axios.get(`${prexzyBaseUrl}/pixwith-result`, {
        params: { job_id: jobId },
        timeout: 30000
      });

      if (resultRes.data?.status && resultRes.data?.image_url) {
        return res.json({
          success: true,
          job_id: jobId,
          original_url: imageUrl,
          result_url: resultRes.data.image_url,
          prompt: prompt,
          model: model
        });
      }
      
      if (resultRes.data?.status === false && !resultRes.data?.message?.toLowerCase()?.includes('process')) {
        throw new Error(resultRes.data.message || 'Processing failed');
      }
    }

    throw new Error('Processing timeout - image is still being generated. Try again later.');

  } catch (error) {
    console.error('Process Error:', error.response?.data || error.message);    res.status(500).json({
      error: 'Processing failed',
      details: error.response?.data?.message || error.message || error.toString()
    });
  }
});

// 🏠 Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🩺 Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// ❌ 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 🚨 Error Handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 🚀 Start Server
app.listen(PORT, () => {
  console.log(`🚀 AI Background Changer Server running on port ${PORT}`);
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`🔗 API Docs: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  process.exit(0);
});
