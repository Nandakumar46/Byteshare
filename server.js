// --- Imports ---
const express = require('express');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const multer = require('multer');
const cors = require('cors');
const { Readable } = require('stream');
const crypto = require('crypto');

// --- Configuration ---
const app = express();
const port = 5000; // The server runs here

// 🔴 CRITICAL: Connection details confirmed to be working:
const mongoURL = 'mongodb+srv://nanda:nanda486@cluster0.ywbpdbz.mongodb.net/'; 
const dbName = 'quick_share_db'; 
const collectionName = 'transfers'; 

// Helper Function: Generate Short Code
/**
 * Generates a short, unique 6-character alphanumeric code.
 * We will use this as the document's _id to keep the transfer code short.
 */
function generateShortCode() {
    // Generate 3 bytes of random data and convert it to a 6-character hexadecimal string
    // This gives us over 16 million unique codes (16^6).
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}


// --- Middleware ---
app.use(cors()); // Allows frontend (browser) to talk to the backend
app.use(express.json()); 

// Multer is set to store file data in memory (RAM) before GridFS saves it
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// --- Database Connection ---
let db;
let gridfsBucket;

MongoClient.connect(mongoURL)
  .then(client => {
    console.log('✅ Connected to MongoDB Atlas');
    db = client.db(dbName);
    // Initialize GridFS for file storage
    gridfsBucket = new GridFSBucket(db, {
      bucketName: 'uploads' 
    });

    // ⭐️ TTL INDEX LOGIC UPDATED TO 12 HOURS ⭐️
    const transfersCollection = db.collection(collectionName);
    
    // index for automatic deletion after 12 hours (12 * 60 * 60 = 43200 seconds)
    const expirySeconds = 12 * 60 * 60; 

    transfersCollection.createIndex(
        { "createdAt": 1 }, // Index on the timestamp field
        { expireAfterSeconds: expirySeconds } // Set the TTL duration
    )
    .then(() => {
        // Updated console message to confirm the new duration
        console.log(`✅ TTL Index created/verified on 'createdAt'. Documents will expire after ${expirySeconds / 3600} hours.`);
    })
    .catch(err => {
        console.error('❌ Failed to create TTL Index:', err);
    });
    // ⭐️ END TTL INDEX LOGIC ⭐️

  })
  .catch(err => {
    // Enhanced error message to guide troubleshooting
    console.error('❌ Failed to connect to MongoDB. Check connection string, user credentials, and IP whitelist on Atlas.', err);
    process.exit(1);
  });

// --- API Endpoints ---

/**
 * POST /api/upload
 * Handles receiving text and files. Generates a short code and uses it as the document ID.
 */
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!db) return res.status(500).send('Database not connected');

  const textData = req.body.text || '';
  // 3. GENERATE: Get the short code
  const shortCode = generateShortCode(); 

  // Function to save metadata after the file is uploaded (or immediately if no file)
  const saveMetadata = (file_id = null) => {
    db.collection(collectionName).insertOne({
      // 4. USE SHORT CODE: Use the short code as the document's primary key (_id)
      _id: shortCode, 
      text: textData,
      file_id: file_id,
      filename: req.file ? req.file.originalname : null,
      // 7. CRITICAL: This is the field the TTL index is monitoring
      createdAt: new Date()
    })
    .then(() => {
      // 5. RETURN SHORT CODE: Return the short code to the user
      res.json({ uniqueId: shortCode });
    })
    .catch(err => {
      // Note: If this fails, it might be a collision (very rare with 6 chars, but possible)
      res.status(500).send('Failed to save transfer metadata. Try uploading again.');
    });
  };

  if (req.file) {
    // 1. Convert file buffer into a readable stream for GridFS
    const readableFileStream = new Readable();
    readableFileStream.push(req.file.buffer);
    readableFileStream.push(null);

    // 2. Open GridFS upload stream and pipe the data to it
    const uploadStream = gridfsBucket.openUploadStream(req.file.originalname, {
        contentType: req.file.mimetype 
    });
    readableFileStream.pipe(uploadStream);

    uploadStream.on('finish', () => {
      saveMetadata(uploadStream.id); // Save metadata using the file's GridFS ID
    });
    
    uploadStream.on('error', err => {
      console.error('GridFS Upload Error:', err);
      res.status(500).send('Failed to upload file to storage.');
    });
  } else {
    // If only text is sent
    saveMetadata();
  }
});

/**
 * GET /api/retrieve/:id
 * Finds the transfer document by its unique short code.
 */
app.get('/api/retrieve/:id', async (req, res) => {
  if (!db) return res.status(500).send('Database not connected');

  try {
    // Ensure we search with uppercase, as the generateShortCode() returns uppercase
    const uniqueId = req.params.id.toUpperCase(); 
    
    // 6. SEARCH BY SHORT CODE: We search directly using the string ID (shortCode), no need for new ObjectId()
    const doc = await db.collection(collectionName).findOne({ _id: uniqueId });

    if (!doc) {
      return res.status(404).send('Error: Transfer ID not found.');
    }

    res.json({
      text: doc.text,
      filename: doc.filename,
      // File ID is still a MongoDB ObjectId, so we keep the conversion to string here
      file_id: doc.file_id ? doc.file_id.toString() : null 
    });

  } catch (err) {
    // This catches general errors
    res.status(400).send('Error retrieving data.');
  }
});

/**
 * GET /api/download/:file_id
 * Streams the file from GridFS storage back to the browser.
 */
app.get('/api/download/:file_id', (req, res) => {
  if (!db) return res.status(500).send('Database not connected');

  try {
    // File ID is the original MongoDB ObjectId
    const fileId = new ObjectId(req.params.file_id);
    
    // Set up the download stream from GridFS
    const downloadStream = gridfsBucket.openDownloadStream(fileId);

    // Set headers for the browser to force a download
    downloadStream.on('file', (file) => {
      res.set('Content-Type', file.contentType);
      res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
    });

    // Pipe the file data directly to the user's response
    downloadStream.pipe(res);

    downloadStream.on('error', () => {
      res.status(404).send('File not found in storage.');
    });

  } catch (err) {
    res.status(400).send('Error: Invalid file ID format.');
  }
});


// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});