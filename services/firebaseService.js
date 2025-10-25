/**
 * ============================================================
 * Firebase Service Module
 * ============================================================
 * 
 * This module handles all Firebase operations:
 * - File uploads to Cloudinary with compression
 * - Message sending to RTDB
 * - Fetching rooms and chats from Firestore
 * - Thread metadata management (unread counts, last read)
 * - User data retrieval
 * 
 * File Upload Features:
 * - Client-side image compression (browser-image-compression)
 * - File size validation with type-specific limits
 * - Progress tracking during upload
 * - Cloudinary integration for media hosting
 */

import { ref, push, onChildAdded, off, get, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { collection, getDocs, doc, setDoc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { auth, db, rtdb } from "./firebase.js";

// Internal reference to the current authenticated user
let currentUser = null;

// ============================================================================
// CLOUDINARY UPLOAD CONFIGURATION
// ============================================================================

const CLOUDINARY_CLOUD_NAME = 'dpki5sq6i';
const CLOUDINARY_UPLOAD_PRESET = 'chat_uploads';

// File size limits (in MB)
const FILE_SIZE_LIMITS = {
  image: 10,      // 10 MB for images
  video: 100,     // 100 MB for videos
  document: 20,   // 20 MB for PDFs/documents
  other: 25       // 25 MB for other files
};

/**
 * Compress and upload file to Cloudinary
 * @param {File} file - The file to upload
 * @param {Function} onProgress - Progress callback (0-100)
 * @returns {Promise<string>} - The secure URL of the uploaded file
 */
export async function uploadToCloudinary(file, onProgress = null) {
  try {
    console.log('[Upload] Starting upload for:', file.name, file.type, file.size);
    
    // ========================================================================
    // CHECK FILE SIZE LIMITS
    // ========================================================================
    const fileSizeMB = file.size / 1024 / 1024;
    let sizeLimit;
    let fileCategory;
    
    if (file.type.startsWith('image/')) {
      sizeLimit = FILE_SIZE_LIMITS.image;
      fileCategory = 'image';
    } else if (file.type.startsWith('video/')) {
      sizeLimit = FILE_SIZE_LIMITS.video;
      fileCategory = 'video';
    } else if (file.type === 'application/pdf' || 
               file.type.includes('document') || 
               file.type.includes('msword') ||
               file.type.includes('officedocument') ||
               file.type.includes('spreadsheet') ||
               file.type.includes('presentation')) {
      sizeLimit = FILE_SIZE_LIMITS.document;
      fileCategory = 'document';
    } else {
      sizeLimit = FILE_SIZE_LIMITS.other;
      fileCategory = 'file';
    }
    
    if (fileSizeMB > sizeLimit) {
      throw new Error(
        `File too large! ${fileCategory}s must be under ${sizeLimit} MB. ` +
        `Your file is ${fileSizeMB.toFixed(2)} MB.`
      );
    }
    
    console.log(`[Upload] File size OK: ${fileSizeMB.toFixed(2)} MB / ${sizeLimit} MB limit`);
    
    let fileToUpload = file;
    
    // ========================================================================
    // COMPRESS IMAGES
    // ========================================================================
    if (file.type.startsWith('image/')) {
      console.log('[Upload] Compressing image...');
      if (onProgress) onProgress(5);
      
      const options = {
        maxSizeMB: 1,           // Max file size in MB
        maxWidthOrHeight: 1920, // Max dimension
        useWebWorker: true,
        fileType: file.type
      };
      
      try {
        fileToUpload = await imageCompression(file, options);
        console.log('[Upload] Image compression complete:', {
          original: (file.size / 1024 / 1024).toFixed(2) + ' MB',
          compressed: (fileToUpload.size / 1024 / 1024).toFixed(2) + ' MB',
          reduction: ((1 - fileToUpload.size / file.size) * 100).toFixed(1) + '%'
        });
        if (onProgress) onProgress(10);
      } catch (compressionError) {
        console.warn('[Upload] Image compression failed, uploading original:', compressionError);
        fileToUpload = file;
      }
    }
    
    // ========================================================================
    // COMPRESS VIDEOS (using Canvas for simple compression)
    // ========================================================================
    else if (file.type.startsWith('video/')) {
      console.log('[Upload] Video detected - checking size...');
      const videoSizeMB = file.size / 1024 / 1024;
      
      // Only compress if video is larger than 10MB
      if (videoSizeMB > 10) {
        console.log('[Upload] Video is large (' + videoSizeMB.toFixed(2) + ' MB), will upload as-is.');
        console.log('[Upload] ℹ️ Cloudinary will optimize on their end');
        // Cloudinary handles video compression server-side automatically
      }
      if (onProgress) onProgress(5);
    }
    
    // ========================================================================
    // COMPRESS PDFs and DOCUMENTS (using simple quality reduction)
    // ========================================================================
    else if (file.type === 'application/pdf' || 
             file.type.includes('document') || 
             file.type.includes('msword') ||
             file.type.includes('officedocument')) {
      console.log('[Upload] Document detected (' + (file.size / 1024 / 1024).toFixed(2) + ' MB)');
      
      // For PDFs and documents, we can't compress them client-side effectively
      // Cloudinary will handle optimization on their end
      if (onProgress) onProgress(5);
    }
    
    // ========================================================================
    // OTHER FILES
    // ========================================================================
    else {
      console.log('[Upload] Other file type detected, uploading as-is');
      if (onProgress) onProgress(5);
    }
    
    // Create FormData for upload
    const formData = new FormData();
    formData.append('file', fileToUpload);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    
    // Add quality optimization for Cloudinary server-side processing
    if (file.type.startsWith('image/')) {
      formData.append('quality', 'auto:good'); // Auto quality optimization
      formData.append('fetch_format', 'auto'); // Auto format selection (WebP, etc.)
    } else if (file.type.startsWith('video/')) {
      formData.append('quality', 'auto'); // Auto quality for videos
    }
    
    // Determine resource type
    let resourceType = 'auto';
    if (file.type.startsWith('video/')) {
      resourceType = 'video';
    } else if (file.type.startsWith('image/')) {
      resourceType = 'image';
    } else {
      resourceType = 'raw'; // For PDFs, docs, etc.
    }
    
    // Upload to Cloudinary
    const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
    
    console.log('[Upload] Uploading to Cloudinary...');
    
    // Use XMLHttpRequest for progress tracking
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const percentComplete = Math.round(((e.loaded / e.total) * 90) + 10); // 10-100%
          onProgress(percentComplete);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          console.log('[Upload] ✅ Upload successful:', response.secure_url);
          if (onProgress) onProgress(100);
          resolve(response.secure_url);
        } else {
          console.error('[Upload] ❌ Upload failed:', xhr.status, xhr.responseText);
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });
      
      xhr.addEventListener('error', () => {
        console.error('[Upload] ❌ Network error during upload');
        reject(new Error('Network error during upload'));
      });
      
      xhr.open('POST', uploadUrl);
      xhr.send(formData);
    });
    
  } catch (error) {
    console.error('[Upload] ❌ Error:', error);
    throw error;
  }
}

/**
 * NOTE: Cloudinary Deletion from Browser
 * 
 * Unsigned uploads (what we use) CANNOT delete files for security reasons.
 * Only signed uploads with API secret can delete files.
 * 
 * Options:
 * 1. Accept that canceled uploads stay on Cloudinary (they're small and cheap)
 * 2. Set up auto-delete after 24h in Cloudinary dashboard (Settings > Upload)
 * 3. Create a backend service with API secret to handle deletions
 * 
 * For now: Files stay uploaded but won't be sent to chat when canceled.
 */

// ============================================================
// MIME TYPE HELPERS
// ============================================================

/**
 * Check if a MIME type is an image
 * @param {string} mime - MIME type string (e.g., "image/png")
 * @returns {boolean} True if the MIME type is an image
 */
export function isImageMime(mime) {
  return mime && mime.startsWith('image/');
}

/**
 * Check if a MIME type is a video
 * @param {string} mime - MIME type string (e.g., "video/mp4")
 * @returns {boolean} True if the MIME type is a video
 */
export function isVideoMime(mime) {
  return mime && mime.startsWith('video/');
}

// ============================================================
// USER HELPERS
// ============================================================

/**
 * Initialize the service with the authenticated user
 * @param {Object} user - The authenticated user object
 */
export function init(user) {
  currentUser = user;
}

/**
 * Get user data from RTDB
 * @param {string} userId - The user ID
 * @returns {Promise<Object|null>} User data or null
 */
export async function getUserFromRTDB(userId) {
  try {
    const userRef = ref(rtdb, `users/${userId}`);
    const userSnap = await get(userRef);
    
    if (userSnap.exists()) {
      return userSnap.val();
    }
    return null;
  } catch (error) {
    console.error('[getUserFromRTDB] Error:', error);
    return null;
  }
}

/**
 * Fetch all rooms and chats from Firestore
 * @returns {Promise<{rooms: Array, chats: Array}>}
 */
export async function fetchRoomsAndChats() {
  console.log('[firebaseService] Starting fetchRoomsAndChats...');
  
  try {
    const rooms = [];
    const chats = [];

    // Fetch rooms from Firestore
    try {
      console.log('[firebaseService] Fetching rooms collection...');
      const roomsCollection = collection(db, "rooms");
      const roomsSnapshot = await getDocs(roomsCollection);
      console.log('[firebaseService] Rooms snapshot received, size:', roomsSnapshot.size);
      
      roomsSnapshot.forEach((doc) => {
        const data = doc.data();
        rooms.push({
          id: doc.id,
          name: data.name || doc.id,
          members: data.members || [],
          unread: 0, // Will be updated from threadMeta
          ...data
        });
      });
      console.log('[firebaseService] Processed rooms:', rooms.length);
    } catch (error) {
      console.error('[firebaseService] Error fetching rooms:', error);
      console.error('[firebaseService] Error code:', error.code);
      console.error('[firebaseService] Error message:', error.message);
      // Continue execution even if rooms fetch fails - return empty array
    }

    // Fetch DM threads/chats from Firestore
    try {
      console.log('[firebaseService] Fetching dm_threads collection...');
      const chatsCollection = collection(db, "dm_threads");
      const chatsSnapshot = await getDocs(chatsCollection);
      console.log('[firebaseService] Chats snapshot received, size:', chatsSnapshot.size);
      
      chatsSnapshot.forEach((doc) => {
        const data = doc.data();
        chats.push({
          id: doc.id,
          name: data.name || doc.id,
          members: data.members || [],
          lastMessage: data.lastMessage || null,
          unread: 0, // Will be updated from threadMeta
          ...data
        });
      });
      console.log('[firebaseService] Processed chats from dm_threads:', chats.length);
    } catch (error) {
      console.error('[firebaseService] Error fetching dm_threads:', error);
      console.error('[firebaseService] Error code:', error.code);
    }
      
    // Try alternative collection name 'dms' if dm_threads is empty
    if (chats.length === 0) {
      try {
        console.log('[firebaseService] Trying alternative collection: dms...');
        const dmsCollection = collection(db, "dms");
        const dmsSnapshot = await getDocs(dmsCollection);
        console.log('[firebaseService] DMs snapshot received, size:', dmsSnapshot.size);
        
        dmsSnapshot.forEach((doc) => {
          const data = doc.data();
          chats.push({
            id: doc.id,
            name: data.name || doc.id,
            members: data.members || [],
            lastMessage: data.lastMessage || null,
            unread: 0, // Will be updated from threadMeta
            ...data
          });
        });
        console.log('[firebaseService] Processed chats from dms collection:', chats.length);
      } catch (altError) {
        console.error('[firebaseService] Error fetching from dms collection:', altError);
        console.error('[firebaseService] Error code:', altError.code);
      }
    }
      
    // Try alternative collection name 'chats' if both are empty
    if (chats.length === 0) {
      try {
        console.log('[firebaseService] Trying alternative collection: chats...');
        const chatsCollection2 = collection(db, "chats");
        const chatsSnapshot2 = await getDocs(chatsCollection2);
        console.log('[firebaseService] Chats snapshot received, size:', chatsSnapshot2.size);
        
        chatsSnapshot2.forEach((doc) => {
          const data = doc.data();
          chats.push({
            id: doc.id,
            name: data.name || doc.id,
            members: data.members || [],
            lastMessage: data.lastMessage || null,
            unread: 0, // Will be updated from threadMeta
            ...data
          });
        });
        console.log('[firebaseService] Processed chats from chats collection:', chats.length);
      } catch (altError) {
        console.error('[firebaseService] Error fetching from chats collection:', altError);
        console.error('[firebaseService] Error code:', altError.code);
      }
    }

    // Fetch unread counts from threadMeta for current user
    if (currentUser && currentUser.uid) {
      try {
        console.log('[firebaseService] Fetching threadMeta for unread counts...');
        const threadMetaCollection = collection(db, "threadMeta");
        const threadMetaSnapshot = await getDocs(threadMetaCollection);
        
        threadMetaSnapshot.forEach((doc) => {
          const data = doc.data();
          const unreadCounts = data.unreadCounts || {};
          const userUnread = unreadCounts[currentUser.uid] || 0;
          
          // Update rooms
          const room = rooms.find(r => doc.id === `room_${r.id}`);
          if (room) {
            room.unread = userUnread;
          }
          
          // Update chats
          const chat = chats.find(c => doc.id === `dm_${c.id}`);
          if (chat) {
            chat.unread = userUnread;
          }
        });
        
        console.log('[firebaseService] ✅ Updated unread counts from threadMeta');
      } catch (error) {
        console.error('[firebaseService] Error fetching threadMeta:', error);
        // Continue without unread counts
      }
    }

    console.log('[firebaseService] ✅ fetchRoomsAndChats completed successfully');
    console.log('[firebaseService] Final results - Rooms:', rooms.length, 'Chats:', chats.length);
    return { rooms, chats };
  } catch (error) {
    console.error('[firebaseService] ❌ Critical error in fetchRoomsAndChats:', error);
    console.error('[firebaseService] Error stack:', error.stack);
    throw error;
  }
}

/**
 * Get the RTDB path for a thread
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @returns {string} - The RTDB path
 */
export function getThreadPath(threadType, threadId) {
  if (threadType === "room") {
    return `messages/rooms/${threadId}`;
  } else if (threadType === "dm") {
    return `messages/dms/${threadId}`;
  }
  throw new Error(`Invalid threadType: ${threadType}`);
}

/**
 * Listen for messages in a thread
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @param {Function} onMessage - Callback for each message
 * @returns {Object} - Reference to the listener for cleanup
 */
export function listenForMessages(threadType, threadId, onMessage) {
  try {
    const path = getThreadPath(threadType, threadId);
    const messagesRef = ref(rtdb, path);

    // Attach listener for existing and new messages
    const listener = onChildAdded(messagesRef, (snapshot) => {
      const messageData = snapshot.val();
      const messageObj = {
        id: snapshot.key,
        senderId: messageData.senderId || "",
        senderName: messageData.senderName || "Unknown",
        type: messageData.type || "incoming",
        text: messageData.text || "",
        createdAt: messageData.createdAt || Date.now(),
        ...(messageData.image && { image: messageData.image }),
        ...(messageData.video && { video: messageData.video }),
        ...(messageData.file && { file: messageData.file })
      };

      onMessage(messageObj);
    });

    // Return the reference for cleanup
    return { ref: messagesRef, listener };
  } catch (error) {
    console.error("Error in listenForMessages:", error);
    throw error;
  }
}

/**
 * Save message to RTDB with custom ID (for tempId synchronization)
 * This is the NEW method for WhatsApp-style single-placeholder flow.
 * 
 * Instead of using push() which generates auto-IDs, we use set() with
 * a custom ID (tempId) so the client can match and merge placeholders.
 * 
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @param {Object} message - Message object (MUST include message.id or message.tempId)
 * @returns {Promise<Object>} - The saved message with id
 */
export async function saveMessage(threadType, threadId, message) {
  try {
    if (!currentUser) {
      throw new Error("User not initialized. Call init(user) first.");
    }

    // Ensure message has an ID (tempId)
    if (!message.id && !message.tempId) {
      throw new Error("Message must have an id or tempId for single-placeholder sync");
    }

    const messageId = message.id || message.tempId;
    const path = getThreadPath(threadType, threadId);
    const messageRef = ref(rtdb, `${path}/${messageId}`);

    // Prepare message with required fields
    const messageToSave = {
      ...message,
      id: messageId, // Ensure id is set
      senderId: message.senderId || currentUser.uid || currentUser.id || "unknown",
      senderName: message.senderName || currentUser.displayName || currentUser.name || "Anonymous",
      createdAt: message.createdAt || Date.now()
    };

    // Save to RTDB using custom ID
    await set(messageRef, messageToSave);
    console.log(`[saveMessage] ✅ Message saved with ID: ${messageId}`);

    // Update lastMessage in Firestore (for sidebar display)
    try {
      const collectionName = threadType === 'room' ? 'rooms' : 'dms';
      const threadDocRef = doc(db, collectionName, threadId);
      
      await updateDoc(threadDocRef, {
        lastMessage: messageToSave.text || '📎 Attachment',
        lastMessageTime: messageToSave.createdAt,
        lastMessageSender: messageToSave.senderId
      });
      
      console.log(`[saveMessage] ✅ Updated lastMessage in Firestore ${collectionName}/${threadId}`);
    } catch (firestoreError) {
      console.error('[saveMessage] ⚠️ Failed to update lastMessage in Firestore:', firestoreError);
      // Don't throw - message still saved to RTDB successfully
    }

    // Increment unread count for other members
    try {
      const collectionName = threadType === 'room' ? 'rooms' : 'dms';
      const threadDocRef = doc(db, collectionName, threadId);
      const threadDoc = await getDoc(threadDocRef);
      
      if (threadDoc.exists()) {
        const memberIds = threadDoc.data().members || [];
        await incrementUnreadCount(threadType, threadId, currentUser.uid, memberIds);
        console.log(`[saveMessage] ✅ Incremented unread counts for other members`);
      }
    } catch (unreadError) {
      console.error('[saveMessage] ⚠️ Failed to increment unread counts:', unreadError);
      // Don't throw - message still saved successfully
    }

    return messageToSave;
  } catch (error) {
    console.error("[saveMessage] Error:", error);
    throw error;
  }
}

/**
 * Send message to RTDB (legacy method using push for auto-ID)
 * @deprecated Use saveMessage() instead for better placeholder synchronization
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @param {Object} message - The message object
 * @returns {Promise<Object>} - The pushed message with id
 */
export async function sendMessage(threadType, threadId, message) {
  try {
    if (!currentUser) {
      throw new Error("User not initialized. Call init(user) first.");
    }

    const path = getThreadPath(threadType, threadId);
    const messagesRef = ref(rtdb, path);

    // Prepare message with required fields
    const messageToSend = {
      ...message,
      senderId: currentUser.uid || currentUser.id || "unknown",
      senderName: currentUser.displayName || currentUser.name || "Anonymous",
      createdAt: Date.now()
    };

    // Push to RTDB
    const pushedRef = await push(messagesRef, messageToSend);

    // Update lastMessage in Firestore (for sidebar display)
    try {
      const collectionName = threadType === 'room' ? 'rooms' : 'dms';
      const threadDocRef = doc(db, collectionName, threadId);
      
      await updateDoc(threadDocRef, {
        lastMessage: messageToSend.text || '',
        lastMessageTime: messageToSend.createdAt,
        lastMessageSender: messageToSend.senderId
      });
      
      console.log(`[sendMessage] ✅ Updated lastMessage in Firestore ${collectionName}/${threadId}`);
    } catch (firestoreError) {
      console.error('[sendMessage] ⚠️ Failed to update lastMessage in Firestore:', firestoreError);
      // Don't throw - message still sent to RTDB successfully
    }

    // Increment unread count for other members
    try {
      // Fetch member list from Firestore
      const collectionName = threadType === 'room' ? 'rooms' : 'dms';
      const threadDocRef = doc(db, collectionName, threadId);
      const threadDoc = await getDoc(threadDocRef);
      
      if (threadDoc.exists()) {
        const memberIds = threadDoc.data().members || [];
        await incrementUnreadCount(threadType, threadId, currentUser.uid, memberIds);
        console.log(`[sendMessage] ✅ Incremented unread counts for other members`);
      }
    } catch (unreadError) {
      console.error('[sendMessage] ⚠️ Failed to increment unread counts:', unreadError);
      // Don't throw - message still sent successfully
    }

    // Return the full message with the generated id
    return {
      id: pushedRef.key,
      ...messageToSend
    };
  } catch (error) {
    console.error("Error in sendMessage:", error);
    throw error;
  }
}

/**
 * Close/detach a message listener
 * @param {Object} listenerRef - The listener reference object from listenForMessages
 */
export function closeMessageListener(listenerRef) {
  try {
    if (listenerRef && listenerRef.ref) {
      off(listenerRef.ref, "child_added", listenerRef.listener);
    }
  } catch (error) {
    console.error("Error in closeMessageListener:", error);
    throw error;
  }
}

/**
 * Mark a thread as read for the current user
 * Updates Firestore threadMeta collection with unread counts and last seen timestamp
 * 
 * Firestore Schema:
 * Collection: threadMeta
 * Document ID: {threadType}_{threadId} (e.g., "room_general", "dm_abc123")
 * Fields:
 *   - unreadCounts: { [userId]: number } - Unread count per user
 *   - lastSeen: { [userId]: timestamp } - Last seen timestamp per user
 *   - threadType: string - 'room' or 'dm'
 *   - threadId: string - The thread identifier
 * 
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @param {string} userId - The user ID to mark as read
 * @returns {Promise<void>}
 */
export async function markThreadRead(threadType, threadId, userId) {
  try {
    console.log(`[markThreadRead] Marking ${threadType}:${threadId} as read for user ${userId}`);
    
    if (!userId) {
      console.warn('[markThreadRead] No userId provided');
      return;
    }

    // Create document ID: threadType_threadId
    const docId = `${threadType}_${threadId}`;
    const threadMetaRef = doc(db, 'threadMeta', docId);

    // Get current document
    const threadMetaDoc = await getDoc(threadMetaRef);
    
    const now = Date.now();
    
    if (threadMetaDoc.exists()) {
      // Update existing document
      const currentData = threadMetaDoc.data();
      const unreadCounts = currentData.unreadCounts || {};
      const lastSeen = currentData.lastSeen || {};
      
      // Reset unread count for this user
      unreadCounts[userId] = 0;
      lastSeen[userId] = now;
      
      await updateDoc(threadMetaRef, {
        unreadCounts,
        lastSeen,
        lastUpdated: now
      });
      
      console.log(`[markThreadRead] ✅ Updated unread count for ${threadType}:${threadId}`);
    } else {
      // Create new document
      await setDoc(threadMetaRef, {
        threadType,
        threadId,
        unreadCounts: {
          [userId]: 0
        },
        lastSeen: {
          [userId]: now
        },
        createdAt: now,
        lastUpdated: now
      });
      
      console.log(`[markThreadRead] ✅ Created new threadMeta for ${threadType}:${threadId}`);
    }
  } catch (error) {
    console.error('[markThreadRead] ❌ Error marking thread as read:', error);
    // Don't throw - this is a non-critical feature
  }
}

/**
 * Increment unread count for a thread for specific users
 * Called when a new message is sent to notify other users
 * 
 * @param {string} threadType - 'room' or 'dm'
 * @param {string} threadId - The thread identifier
 * @param {string} senderId - The sender's user ID (to exclude from unread increment)
 * @param {Array<string>} memberIds - All member IDs in the thread
 * @returns {Promise<void>}
 */
export async function incrementUnreadCount(threadType, threadId, senderId, memberIds) {
  try {
    console.log(`[incrementUnreadCount] Incrementing for ${threadType}:${threadId}`);
    
    if (!memberIds || memberIds.length === 0) {
      console.warn('[incrementUnreadCount] No member IDs provided');
      return;
    }

    const docId = `${threadType}_${threadId}`;
    const threadMetaRef = doc(db, 'threadMeta', docId);

    // Get current document
    const threadMetaDoc = await getDoc(threadMetaRef);
    
    const now = Date.now();
    
    if (threadMetaDoc.exists()) {
      const currentData = threadMetaDoc.data();
      const unreadCounts = currentData.unreadCounts || {};
      
      // Increment unread count for all members except sender
      memberIds.forEach(memberId => {
        if (memberId !== senderId) {
          unreadCounts[memberId] = (unreadCounts[memberId] || 0) + 1;
        }
      });
      
      await updateDoc(threadMetaRef, {
        unreadCounts,
        lastUpdated: now
      });
      
      console.log(`[incrementUnreadCount] ✅ Updated unread counts`);
    } else {
      // Create new document with initial unread counts
      const unreadCounts = {};
      memberIds.forEach(memberId => {
        if (memberId !== senderId) {
          unreadCounts[memberId] = 1;
        } else {
          unreadCounts[memberId] = 0;
        }
      });
      
      await setDoc(threadMetaRef, {
        threadType,
        threadId,
        unreadCounts,
        lastSeen: {},
        createdAt: now,
        lastUpdated: now
      });
      
      console.log(`[incrementUnreadCount] ✅ Created threadMeta with unread counts`);
    }
  } catch (error) {
    console.error('[incrementUnreadCount] ❌ Error incrementing unread:', error);
    // Don't throw - this is a non-critical feature
  }
}
