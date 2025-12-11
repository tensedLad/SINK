/**
 * ============================================================
 * SEED MESSAGES SCRIPT
 * ============================================================
 * 
 * This script pushes fake test messages to Firebase Realtime Database
 * for testing purposes.
 * 
 * Usage: node scripts/seed-messages.js
 * 
 * Make sure you have firebase-admin installed:
 *   npm install firebase-admin
 */

const admin = require('firebase-admin');

// Firebase Admin SDK Configuration
// Using the same project as the web app
const firebaseConfig = {
  projectId: "sink-ecosystem",
  databaseURL: "https://sink-ecosystem-default-rtdb.firebaseio.com",
};

// Initialize Firebase Admin with default credentials
// For local testing, you can use the Firebase emulator or set up service account
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: firebaseConfig.databaseURL
});

const db = admin.database();
const firestore = admin.firestore();

// ============================================================
// FAKE USER DATA
// ============================================================
const fakeUsers = [
  {
    uid: 'user_test_1',
    name: 'Alice Johnson',
    email: 'alice@example.com',
    avatar: 'https://ui-avatars.com/api/?name=Alice+Johnson&background=6366f1&color=fff'
  },
  {
    uid: 'user_test_2', 
    name: 'Bob Smith',
    email: 'bob@example.com',
    avatar: 'https://ui-avatars.com/api/?name=Bob+Smith&background=22c55e&color=fff'
  },
  {
    uid: 'user_test_3',
    name: 'Charlie Davis',
    email: 'charlie@example.com',
    avatar: 'https://ui-avatars.com/api/?name=Charlie+Davis&background=f59e0b&color=fff'
  },
  {
    uid: 'user_test_4',
    name: 'Diana Lee',
    email: 'diana@example.com',
    avatar: 'https://ui-avatars.com/api/?name=Diana+Lee&background=ec4899&color=fff'
  }
];

// ============================================================
// FAKE ROOM MESSAGES
// ============================================================
const roomConversations = {
  // Messages will be added to rooms that exist in Firestore
  // The room ID will be fetched dynamically
  general: [
    { text: "Hey everyone! 👋 Welcome to the team chat!", sender: 0 },
    { text: "Thanks for having us! Excited to be here.", sender: 1 },
    { text: "Quick question - where can I find the project documentation?", sender: 2 },
    { text: "Check out the Wiki page, I'll send you the link", sender: 0 },
    { text: "Here's the doc: https://wiki.example.com/project-docs", sender: 0 },
    { text: "Perfect, thanks Alice! 🙏", sender: 2 },
    { text: "Anyone up for a quick sync call today?", sender: 3 },
    { text: "I'm free after 3pm", sender: 1 },
    { text: "Same here, 3pm works for me", sender: 0 },
    { text: "Great! I'll set up a meeting invite", sender: 3 },
    { text: "Don't forget we have the sprint review tomorrow at 10am", sender: 1 },
    { text: "Oh right! I need to prepare my demo", sender: 2 },
    { text: "Let me know if you need help with anything", sender: 0 },
    { text: "Will do! The new feature is almost ready 🚀", sender: 2 },
    { text: "Can't wait to see it in action!", sender: 3 }
  ]
};

// ============================================================
// FAKE DM MESSAGES
// ============================================================
const dmConversations = [
  // Conversation between user 0 and user 1
  {
    participants: [0, 1],
    messages: [
      { text: "Hey Bob, got a minute?", sender: 0 },
      { text: "Sure, what's up?", sender: 1 },
      { text: "I wanted to discuss the new API design", sender: 0 },
      { text: "The current implementation seems a bit complex", sender: 0 },
      { text: "Yeah I was thinking the same thing", sender: 1 },
      { text: "What if we simplify the authentication flow?", sender: 1 },
      { text: "That's a good idea. Maybe use JWT tokens?", sender: 0 },
      { text: "Exactly! I'll draft a proposal", sender: 1 },
      { text: "Perfect, let me know when it's ready for review", sender: 0 },
      { text: "Will do! Should have it by EOD", sender: 1 }
    ]
  },
  // Conversation between user 2 and user 3
  {
    participants: [2, 3],
    messages: [
      { text: "Diana! Did you see the latest designs?", sender: 2 },
      { text: "Not yet, send them over!", sender: 3 },
      { text: "Just uploaded to Figma", sender: 2 },
      { text: "Love the new color scheme! 🎨", sender: 3 },
      { text: "Thanks! Took a while to get it right", sender: 2 },
      { text: "The dark mode looks especially good", sender: 3 },
      { text: "Should we present it at the next standup?", sender: 2 },
      { text: "Definitely! Let's prepare some slides", sender: 3 }
    ]
  }
];

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Generate a unique message ID
 */
function generateMessageId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * Generate a DM thread ID from two user IDs
 * Always sorts the IDs to ensure consistent thread ID
 */
function generateDmThreadId(userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return `${sortedIds[0]}_${sortedIds[1]}`;
}

/**
 * Create a message object
 */
function createMessage(text, senderUser, baseTimestamp, offsetMinutes) {
  return {
    id: generateMessageId(),
    senderId: senderUser.uid,
    senderName: senderUser.name,
    senderAvatar: senderUser.avatar,
    type: 'text',
    text: text,
    createdAt: baseTimestamp + (offsetMinutes * 60 * 1000)
  };
}

// ============================================================
// MAIN SEEDING FUNCTIONS
// ============================================================

/**
 * Seed messages for rooms
 */
async function seedRoomMessages() {
  console.log('\n📝 Seeding room messages...\n');
  
  try {
    // First, fetch existing rooms from Firestore
    const roomsSnapshot = await firestore.collection('rooms').get();
    
    if (roomsSnapshot.empty) {
      console.log('⚠️ No rooms found in Firestore. Creating a sample room...');
      
      // Create a sample room
      const sampleRoomRef = firestore.collection('rooms').doc('general');
      await sampleRoomRef.set({
        name: 'General',
        description: 'General discussion room',
        members: fakeUsers.map(u => u.uid),
        createdAt: Date.now(),
        icon: '#'
      });
      
      console.log('✅ Created sample "General" room');
    }
    
    // Fetch rooms again
    const updatedRoomsSnapshot = await firestore.collection('rooms').get();
    
    // Use current time as base, messages spread over past 2 hours
    const now = Date.now();
    const twoHoursAgo = now - (2 * 60 * 60 * 1000);
    
    for (const roomDoc of updatedRoomsSnapshot.docs) {
      const roomId = roomDoc.id;
      const roomData = roomDoc.data();
      console.log(`\n🏠 Adding messages to room: ${roomData.name || roomId}`);
      
      // Get messages for this room (use general conversation for all rooms)
      const messages = roomConversations.general;
      const messagesPath = `messages/rooms/${roomId}`;
      
      // Calculate time interval between messages
      const timeInterval = (now - twoHoursAgo) / messages.length;
      
      for (let i = 0; i < messages.length; i++) {
        const msgData = messages[i];
        const senderUser = fakeUsers[msgData.sender];
        const messageTime = twoHoursAgo + (i * timeInterval);
        
        const message = {
          id: generateMessageId(),
          senderId: senderUser.uid,
          senderName: senderUser.name,
          senderAvatar: senderUser.avatar,
          type: 'text',
          text: msgData.text,
          createdAt: Math.floor(messageTime)
        };
        
        // Push to RTDB
        const messageRef = db.ref(`${messagesPath}/${message.id}`);
        await messageRef.set(message);
        
        console.log(`  ✅ Added: "${msgData.text.substring(0, 30)}..." from ${senderUser.name}`);
      }
      
      // Update room's last message in Firestore
      const lastMsg = messages[messages.length - 1];
      await firestore.collection('rooms').doc(roomId).update({
        lastMessage: lastMsg.text,
        lastMessageTime: now,
        lastMessageSender: fakeUsers[lastMsg.sender].uid
      });
    }
    
    console.log('\n✅ Room messages seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding room messages:', error);
    throw error;
  }
}

/**
 * Seed messages for DMs
 */
async function seedDmMessages() {
  console.log('\n📬 Seeding DM messages...\n');
  
  try {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    for (const conversation of dmConversations) {
      const user1 = fakeUsers[conversation.participants[0]];
      const user2 = fakeUsers[conversation.participants[1]];
      const threadId = generateDmThreadId(user1.uid, user2.uid);
      
      console.log(`\n💬 Creating DM between ${user1.name} and ${user2.name}`);
      console.log(`   Thread ID: ${threadId}`);
      
      // Create DM thread in Firestore (try multiple collection names)
      const dmThreadData = {
        members: [user1.uid, user2.uid],
        memberDetails: {
          [user1.uid]: { name: user1.name, avatar: user1.avatar },
          [user2.uid]: { name: user2.name, avatar: user2.avatar }
        },
        createdAt: oneHourAgo,
        lastMessage: conversation.messages[conversation.messages.length - 1].text,
        lastMessageTime: now
      };
      
      // Save to dm_threads collection
      await firestore.collection('dm_threads').doc(threadId).set(dmThreadData, { merge: true });
      
      // Also save to dms collection as fallback
      await firestore.collection('dms').doc(threadId).set(dmThreadData, { merge: true });
      
      console.log('   ✅ Created DM thread in Firestore');
      
      // Add messages to RTDB
      const messagesPath = `messages/dms/${threadId}`;
      const timeInterval = (now - oneHourAgo) / conversation.messages.length;
      
      for (let i = 0; i < conversation.messages.length; i++) {
        const msgData = conversation.messages[i];
        const senderUser = fakeUsers[conversation.participants[msgData.sender === 0 ? 0 : 1]];
        const messageTime = oneHourAgo + (i * timeInterval);
        
        const message = {
          id: generateMessageId(),
          senderId: senderUser.uid,
          senderName: senderUser.name,
          senderAvatar: senderUser.avatar,
          type: 'text',
          text: msgData.text,
          createdAt: Math.floor(messageTime)
        };
        
        const messageRef = db.ref(`${messagesPath}/${message.id}`);
        await messageRef.set(message);
        
        console.log(`   ✅ Added: "${msgData.text.substring(0, 30)}..." from ${senderUser.name}`);
      }
    }
    
    console.log('\n✅ DM messages seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding DM messages:', error);
    throw error;
  }
}

/**
 * Seed test users to RTDB
 */
async function seedUsers() {
  console.log('\n👥 Seeding test users...\n');
  
  try {
    for (const user of fakeUsers) {
      const userRef = db.ref(`users/${user.uid}`);
      await userRef.set({
        name: user.name,
        username: user.email.split('@')[0],
        email: user.email,
        uid: user.uid,
        status: 'offline',
        lastSeen: Date.now(),
        avatar: user.avatar
      });
      console.log(`  ✅ Created user: ${user.name}`);
    }
    
    console.log('\n✅ Test users seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding users:', error);
    throw error;
  }
}

// ============================================================
// RUN SCRIPT
// ============================================================

async function main() {
  console.log('============================================================');
  console.log('  SINK - Firebase Message Seeder');
  console.log('============================================================');
  console.log('\nThis script will add fake test messages to your Firebase.');
  console.log('Project: sink-ecosystem');
  console.log('Database URL:', firebaseConfig.databaseURL);
  
  try {
    // Seed data
    await seedUsers();
    await seedRoomMessages();
    await seedDmMessages();
    
    console.log('\n============================================================');
    console.log('  ✅ ALL DATA SEEDED SUCCESSFULLY!');
    console.log('============================================================\n');
    
    console.log('Summary:');
    console.log(`  - ${fakeUsers.length} test users created`);
    console.log(`  - ${roomConversations.general.length} room messages per room`);
    console.log(`  - ${dmConversations.length} DM conversations created`);
    console.log('\nYou can now refresh your SINK app to see the messages!');
    
  } catch (error) {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    // Close Firebase connection
    await admin.app().delete();
    process.exit(0);
  }
}

main();
