/**
 * ============================================================
 * Firebase Configuration & Services
 * ============================================================
 * 
 * This module initializes and exports Firebase services:
 * - Authentication (auth)
 * - Firestore Database (db)
 * - Realtime Database (rtdb)
 * - Cloud Storage (storage)
 * 
 * Also provides helper functions for:
 * - User profile creation
 * - Message sending/listening
 * - Presence tracking (online/offline status)
 */

// Import Firebase modules from CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, set, push, onValue, update, serverTimestamp, onChildAdded, query, orderByChild, limitToLast, get, onDisconnect } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDFa9_Zj-EZ8_wpERlGPhMwyFfeMkwugg8",
  authDomain: "sink-ecosystem.firebaseapp.com",
  projectId: "sink-ecosystem",
  storageBucket: "sink-ecosystem.appspot.com",
  messagingSenderId: "437922605443",
  appId: "1:437922605443:web:4d9a01f4ea94a8f045aeb6",
  measurementId: "G-PC75M5L9TM",
  databaseURL: "https://sink-ecosystem-default-rtdb.firebaseio.com",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Firebase services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const storage = getStorage(app);

// Export Firebase functions for easy access
export {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  ref,
  set,
  push,
  onValue,
  update,
  serverTimestamp,
  onChildAdded,
  query,
  orderByChild,
  limitToLast,
  get,
  onDisconnect,
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc,
  updateDoc
};

// Create user profile in Firestore and Realtime Database
export const createUserProfileDocument = async (user, additionalData) => {
  if (!user) return;
  
  const { displayName } = user;
  const { username, displayName: addDisplayName } = additionalData || {};
  const name = addDisplayName || displayName || username || 'Anonymous';
  
  // Extract username from email if not provided
  const extractedUsername = username || user.email?.split('@')[0] || 'user';

  // Update user display name if not set
  if (auth.currentUser && !auth.currentUser.displayName) {
    await updateProfile(auth.currentUser, { displayName: name });
  }

  // Save to Firestore
  const userRef = doc(db, 'user_profiles', user.uid);
  await setDoc(userRef, {
    name: name,
    username: extractedUsername,
    email: user.email,
    uid: user.uid,
    createdAt: new Date().toISOString(),
    status: 'online',
    avatar: user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`
  }, { merge: true });

  // Save to Realtime Database for real-time presence
  const rtdbUserRef = ref(rtdb, `users/${user.uid}`);
  await set(rtdbUserRef, {
    name: name,
    username: extractedUsername,
    email: user.email,
    uid: user.uid,
    status: 'online',
    lastSeen: serverTimestamp(),
    avatar: user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`
  });
  
  // Add user to general room if it exists
  try {
    const roomsSnapshot = await get(ref(rtdb, 'rooms'));
    if (roomsSnapshot.exists()) {
      // Find the general room
      let generalRoomId = null;
      roomsSnapshot.forEach((roomSnapshot) => {
        const roomData = roomSnapshot.val();
        if (roomData.name === 'General' || roomData.icon === '#') {
          generalRoomId = roomSnapshot.key;
        }
      });
      
      // Add user to general room members
      if (generalRoomId) {
        const memberRef = ref(rtdb, `rooms/${generalRoomId}/members/${user.uid}`);
        await set(memberRef, {
          name: name,
          username: extractedUsername,
          joinedAt: serverTimestamp()
        });
        
        // Update member count
        const roomRef = ref(rtdb, `rooms/${generalRoomId}`);
        const roomSnapshot = await get(roomRef);
        if (roomSnapshot.exists()) {
          const currentMembers = roomSnapshot.val().memberCount || 0;
          await update(roomRef, {
            memberCount: currentMembers + 1
          });
        }
      }
    }
  } catch (error) {
    console.error('Error adding user to general room:', error);
  }
};

// Send a message to a room or chat
export const sendMessage = async (chatId, messageData, currentUser) => {
  if (!currentUser) return;

  const messagesRef = ref(rtdb, `messages/${chatId}`);
  const newMessageRef = push(messagesRef);
  
  await set(newMessageRef, {
    ...messageData,
    senderId: currentUser.uid,
    senderName: currentUser.displayName || 'Anonymous',
    senderAvatar: currentUser.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.displayName || 'Anonymous')}&background=random`,
    timestamp: serverTimestamp(),
    createdAt: new Date().toISOString()
  });

  // Update last message in chat metadata
  const chatMetaRef = ref(rtdb, `chats/${chatId}`);
  await update(chatMetaRef, {
    lastMessage: messageData.text || 'Media',
    lastMessageTime: serverTimestamp(),
    lastSender: currentUser.uid
  });
};

// Listen for messages in a room or chat
export const listenToMessages = (chatId, callback) => {
  const messagesRef = query(
    ref(rtdb, `messages/${chatId}`),
    orderByChild('timestamp'),
    limitToLast(100)
  );
  
  return onValue(messagesRef, (snapshot) => {
    const messages = [];
    snapshot.forEach((childSnapshot) => {
      messages.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });
    callback(messages);
  });
};

// Get current user profile
export const getUserProfile = async (uid) => {
  const userRef = ref(rtdb, `users/${uid}`);
  const snapshot = await get(userRef);
  return snapshot.val();
};

// Update user status
export const updateUserStatus = async (uid, status) => {
  const userRef = ref(rtdb, `users/${uid}`);
  await update(userRef, {
    status: status,
    lastSeen: serverTimestamp()
  });
};

/**
 * Setup presence tracking for a user
 * Automatically sets user as online when connected and offline when disconnected
 * @param {string} uid - User ID
 */
export const setupPresenceTracking = (uid) => {
  if (!uid) {
    console.error('[Presence] No UID provided');
    return;
  }

  console.log('[Presence] Setting up presence tracking for:', uid);

  const userStatusRef = ref(rtdb, `users/${uid}`);
  
  // Create a reference to the special '.info/connected' path in RTDB
  // This is a special location that is true when connected and false when disconnected
  const connectedRef = ref(rtdb, '.info/connected');

  onValue(connectedRef, (snapshot) => {
    if (snapshot.val() === false) {
      // Not connected to Firebase, skip
      console.log('[Presence] Not connected to Firebase');
      return;
    }

    console.log('[Presence] Connected to Firebase, setting up disconnect handlers');

    // When we disconnect, set status to offline
    onDisconnect(userStatusRef)
      .update({
        status: 'offline',
        lastSeen: serverTimestamp()
      })
      .then(() => {
        console.log('[Presence] ✅ onDisconnect handler set');
        
        // While online, set status to online
        update(userStatusRef, {
          status: 'online',
          lastSeen: serverTimestamp()
        }).then(() => {
          console.log('[Presence] ✅ User marked as online');
        });
      })
      .catch((error) => {
        console.error('[Presence] ❌ Error setting up presence:', error);
      });
  });
};
