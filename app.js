/**
 * ============================================================
 * SINK - Real-time Chat Application
 * ============================================================
 * 
 * Features:
 * - Real-time messaging using Firebase Realtime Database
 * - Room-based and direct message chats
 * - File uploads (images, videos, documents) via Cloudinary
 * - Client-side image compression to save bandwidth
 * - User presence tracking (online/offline status)
 * - URL-based routing for deep linking
 * 
 * Architecture:
 * - Pure JavaScript (no framework)
 * - Firebase RTDB for messages
 * - Firestore for metadata (rooms, chats, thread info)
 * - Cloudinary for media hosting
 * 
 * ============================================================
 * MESSAGE SYNCHRONIZATION FLOW (WhatsApp-style Single Placeholder)
 * ============================================================
 * 
 * Problem: Without synchronization, sending a message creates TWO bubbles:
 *   1. Local optimistic placeholder
 *   2. Firebase listener creates duplicate when message arrives
 * 
 * Solution: Use tempId to merge placeholder with Firebase message
 * 
 * FLOW:
 * ------
 * 1. User hits Send → Generate unique tempId (temp_<timestamp>_<random>)
 * 
 * 2. Create local placeholder message:
 *    {
 *      id: tempId,
 *      tempId: tempId,  // Critical for matching
 *      status: 'uploading' | 'sending',
 *      progress: 0-100,
 *      localPreviewUrl: blob URL for instant preview
 *    }
 * 
 * 3. Render placeholder immediately (optimistic UI)
 *    Store in pendingMessages[tempId] = { ...placeholder }
 * 
 * 4. Start upload/send in background:
 *    - For files: uploadService.uploadFile(file, onProgress)
 *    - Update placeholder progress: updateMessageProgress(tempId, %)
 * 
 * 5. When upload completes:
 *    - Save to Firebase using SAME tempId as document key
 *    - firebaseService.saveMessage(chatId, { id: tempId, ...data })
 *    - Update placeholder status: 'uploading' → 'sent'
 * 
 * 6. Firebase listener receives message:
 *    - Check if pendingMessages[tempId] exists
 *    - If YES: Merge data into existing placeholder (update DOM in-place)
 *    - If NO: Render as new message
 *    - Result: Only ONE bubble visible throughout
 * 
 * 7. Error handling:
 *    - Upload fails → Set status: 'failed', show retry button
 *    - User cancels → Remove placeholder, don't save to Firebase
 * 
 * KEY DIFFERENCES from old flow:
 * - OLD: push() generates auto-ID, no way to match placeholder
 * - NEW: set() uses custom tempId, listener finds and merges
 * - OLD: Duplicate bubble appears briefly then removed
 * - NEW: Single bubble updates in-place, never duplicates
 * 
 * DATA STRUCTURES:
 * ----------------
 * pendingMessages = {
 *   'temp_123_abc': { message object with status, progress, xhr },
 *   'temp_124_def': { ... }
 * }
 * 
 * Message status progression:
 * - Text: sending → sent → delivered
 * - Files: uploading → sent → delivered
 * - Failed: uploading → failed (show retry)
 * 
 * DOM attributes for tracking:
 * - data-message-id="${msg.id}"        // Current ID (starts as tempId)
 * - data-temp-id="${msg.tempId}"       // Permanent tempId for matching
 * - data-status="${msg.status}"        // Current status
 * - data-firebase-id="${firebaseId}"   // Real Firebase ID after sync
 */

// ============================================================
// CONSTANTS
// ============================================================

const SinkApp = {
  currentView: null,
  currentUser: null, // Store current authenticated user
  currentThreadListener: null, // Hold active listener reference for cleanup
  messagesCache: {}, // Cache messages by thread key: { 'room:general': [...], 'dm:xyz': [...] }
  processedMessageIds: {}, // Track processed message IDs per thread: { 'room:general': Set(['id1', 'id2']) }
  isUploading: false, // Track upload state to prevent multiple simultaneous uploads
  isSending: false, // Track send state to prevent multiple simultaneous sends
  pendingAttachment: null, // Store uploaded file waiting to be sent
  sentMessageIds: new Set(), // Track message IDs that were sent from this client (to prevent duplicates)

  /**
   * Handle media load error - replace broken image/video with placeholder
   * @param {HTMLElement} element - The img or video element that failed to load
   * @param {string} type - 'image' or 'video'
   */
  handleMediaError(element, type = 'image') {
    if (!element || !element.parentElement) return;

    // Clean 'image-off' and 'video-off' style icons
    const icon = type === 'video'
      ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="text-slate-400" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 2 2m4-4v4.5c0 .8-.6 1.4-1.3 1.5H3c-.8 0-1.5-.7-1.5-1.5v-9c0-.8.7-1.5 1.5-1.5h2l2-3h6l.6.9M22 2 2 22"></path><circle cx="12" cy="13" r="3"></circle></svg>`
      : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="text-slate-400" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2 22 22M9 3h8.5c.8 0 1.5.7 1.5 1.5v8.5M21 15v4.5c0 .8-.7 1.5-1.5 1.5h-15c-.8 0-1.5-.7-1.5-1.5v-13c0-.5.2-.9.6-1.2"></path></svg>`;

    const message = type === 'video' ? 'This video was deleted' : 'This image was deleted';

    element.parentElement.innerHTML = `
      <div class="flex items-center justify-center gap-3 py-8 px-4 bg-slate-800/40 rounded-2xl border border-slate-700/50">
        ${icon}
        <span class="text-slate-400 text-sm font-medium">${message}</span>
      </div>
    `;
  },

  /**
   * Download media file (image/video/file) - handles cross-origin Cloudinary URLs
   * @param {string} url - The media URL to download
   * @param {string} filename - Optional filename for the download
   */
  async downloadMedia(url, filename = null) {
    try {
      console.log('[downloadMedia] Starting download:', url);

      // Show loading indicator (optional toast)
      this.showInfoToast && this.showInfoToast('Downloading...');

      // Check if it's a raw file (non-image/video) - these have CORS restrictions
      const isRawFile = url.includes('/raw/upload/') ||
        url.match(/\.(zip|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i);

      // For raw files, we can't use fetch due to CORS - open directly
      // Browser will auto-download non-viewable file types
      if (isRawFile) {
        console.log('[downloadMedia] Raw file detected, opening in new tab');
        window.open(url, '_blank');
        return;
      }

      // For images/videos - try fl_attachment first (works for Cloudinary images/videos)
      if (url.includes('cloudinary.com') && url.includes('/image/upload/')) {
        const downloadUrl = url.replace('/upload/', '/upload/fl_attachment/');
        window.open(downloadUrl, '_blank');
        return;
      }

      if (url.includes('cloudinary.com') && url.includes('/video/upload/')) {
        const downloadUrl = url.replace('/upload/', '/upload/fl_attachment/');
        window.open(downloadUrl, '_blank');
        return;
      }

      // For other URLs, try fetch + blob
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const downloadFilename = filename || this.extractFilenameFromUrl(url) || 'download';

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = downloadFilename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

      console.log('[downloadMedia] Download complete:', downloadFilename);

    } catch (error) {
      console.error('[downloadMedia] Error:', error);
      // Fallback: open in new tab
      this.showErrorToast && this.showErrorToast('Download failed. Opening in new tab...');
      window.open(url, '_blank');
    }
  },

  /**
   * Extract filename from URL
   */
  extractFilenameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      // Get the last part after the last /
      const parts = pathname.split('/');
      return parts[parts.length - 1] || null;
    } catch {
      return null;
    }
  },

  // ============================================================
  // USER PROFILES CACHE - Reduce Firestore reads
  // ============================================================
  userProfilesCache: {}, // Cache user profiles: { 'userId': { displayName, email, avatar, ... }, ... }

  // ============================================================
  // REAL-TIME LISTENERS - Sidebar updates
  // ============================================================
  sidebarListeners: [], // Track all active sidebar listeners for cleanup

  // ============================================================
  // MESSAGE PROCESSING QUEUE - Maintain chronological order
  // ============================================================
  messageQueue: [], // Queue for processing messages in order
  isProcessingQueue: false, // Flag to prevent concurrent processing

  // ============================================================
  // NEW: WhatsApp-style Single Placeholder System
  // ============================================================
  pendingMessages: {}, // Track optimistic messages by tempId: { '-OcGGVgjEt_uJe3XV_uu': { msg, xhr }, ... }
  pendingUploads: {},  // Track active XHR uploads for cancellation: { '-OcGGVgjEt_uJe3XV_uu': xhr }

  // Firebase-style Push ID generation state
  _lastPushTime: 0,
  _lastRandChars: new Array(12).fill(0),

  // ========== ROUTER SUBSYSTEM ==========

  /**
   * Parse the current URL hash and return a route object
   * @returns {Object} Route object with type ('room'|'chat'|'welcome') and id (string|null)
   */
  getRouteFromHash() {
    const hash = window.location.hash.slice(1); // Remove the '#'

    if (!hash) {
      return { type: 'welcome', id: null };
    }

    const parts = hash.split('/');
    const routeType = parts[0]; // 'room' or 'chat'
    const routeId = parts[1]; // e.g., 'general', 'yash'

    if (routeType === 'room' && routeId) {
      return { type: 'room', id: routeId };
    } else if (routeType === 'chat' && routeId) {
      return { type: 'chat', id: routeId };
    }

    return { type: 'welcome', id: null };
  },

  /**
   * Apply a route by calling the appropriate view function
   * @param {Object} route - Route object from getRouteFromHash()
   */
  applyRoute(route) {
    if (route.type === 'room' && route.id) {
      this.openRoom(route.id);
    } else if (route.type === 'chat' && route.id) {
      this.openChat(route.id);
    } else {
      this.showWelcome();
    }
  },

  /**
   * Navigate to a specific route by updating the hash
   * @param {string} routeType - 'room' or 'chat'
   * @param {string} id - The room or chat id
   */
  navigateTo(routeType, id) {
    if (routeType === 'room') {
      window.location.hash = `#room/${id}`;
    } else if (routeType === 'chat') {
      window.location.hash = `#chat/${id}`;
    } else {
      window.location.hash = '';
    }
  },

  /**
   * Initialize the hash change listener
   */
  initRouter() {
    // Listen for hash changes (back/forward button, manual hash changes)
    window.addEventListener('hashchange', () => {
      const route = this.getRouteFromHash();
      this.applyRoute(route);
    });
  },

  // ========== END ROUTER SUBSYSTEM ==========

  // Data for rooms and chats (will be populated from Firebase)
  data: {
    rooms: [],
    chats: [],
    messages: {}
  },

  // Initialize app (called after Firebase data is loaded)
  async init() {
    this.initRouter(); // Initialize the router first
    await this.updateCurrentUserDisplay(); // Update user info in sidebar
    this.renderSidebar(); // Render sidebar with real data from Firebase

    // Setup real-time sidebar listeners
    this.setupSidebarRealTimeListeners();

    // Apply the current route from URL hash (supports direct links)
    const route = this.getRouteFromHash();
    this.applyRoute(route);

    this.initializeComposer();
  },

  // Update current user display in sidebar footer
  async updateCurrentUserDisplay() {
    const defaultAvatar = 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?q=80&w=120&auto=format&fit=crop';

    // Get DOM elements
    const userNameElement = document.getElementById('currentUserName');
    const userEmailElement = document.getElementById('currentUserEmail');
    const userAvatarElement = document.getElementById('currentUserAvatar');

    // Check if we can access Firebase auth
    if (!window.auth || !window.auth.currentUser) {
      console.warn('⚠️ Auth not available for user display update');
      if (userNameElement) userNameElement.textContent = 'User';
      if (userEmailElement) userEmailElement.textContent = 'Not logged in';
      if (userAvatarElement) userAvatarElement.src = defaultAvatar;
      return;
    }

    this.currentUser = window.auth.currentUser;
    const userId = this.currentUser.uid;

    try {
      // Fetch user data from Firestore (collection name: user_profiles)
      const userDoc = await window.getDoc(window.doc(window.db, 'user_profiles', userId));

      if (userDoc.exists()) {
        const userData = userDoc.data();
        console.log('📋 Firestore User Data:', userData);

        const displayName = userData.displayName || userData.name || this.currentUser.email?.split('@')[0] || 'User';
        const email = userData.email || this.currentUser.email || '';
        // Check multiple possible avatar field names
        const avatar = userData.photoURL || userData.avatar || userData.profilePicture || userData.profileImage || this.currentUser.photoURL || defaultAvatar;

        console.log('👤 Parsed User Info:', { displayName, email, avatar });

        // Update DOM
        if (userNameElement) userNameElement.textContent = displayName;
        if (userEmailElement) userEmailElement.textContent = email;
        if (userAvatarElement) {
          userAvatarElement.src = avatar;
          // Add error handler for image loading failures
          userAvatarElement.onerror = function () {
            console.error('❌ Avatar failed to load:', avatar);
            this.src = defaultAvatar;
            this.onerror = null; // Prevent infinite loop
          };
        }

        console.log('✅ Current user display updated:', { displayName, email, avatarSet: !!avatar });
      } else {
        // Fallback to Auth data if Firestore doc doesn't exist
        const fallbackName = this.currentUser.displayName || this.currentUser.email?.split('@')[0] || 'User';
        const fallbackEmail = this.currentUser.email || '';

        if (userNameElement) userNameElement.textContent = fallbackName;
        if (userEmailElement) userEmailElement.textContent = fallbackEmail;
        if (userAvatarElement) userAvatarElement.src = this.currentUser.photoURL || defaultAvatar;

        console.warn('⚠️ User document not found in Firestore, using Auth data');
      }
    } catch (error) {
      console.error('❌ Error fetching user data:', error);

      // Fallback to Auth data on error
      const fallbackName = this.currentUser.displayName || this.currentUser.email?.split('@')[0] || 'User';
      const fallbackEmail = this.currentUser.email || '';

      if (userNameElement) userNameElement.textContent = fallbackName;
      if (userEmailElement) userEmailElement.textContent = fallbackEmail;
      if (userAvatarElement) userAvatarElement.src = this.currentUser.photoURL || defaultAvatar;
    }
  },

  // ============================================================
  // USER PROFILE CACHING SYSTEM
  // ============================================================

  /**
   * Fetch user profile from cache or Firestore
   * @param {string} userId - User ID to fetch
   * @returns {Promise<Object>} User profile object with { displayName, email, avatar, ... }
   */
  async getUserProfile(userId) {
    // Check cache first
    if (this.userProfilesCache[userId]) {
      console.log(`[Cache] Using cached profile for: ${userId}`);
      return this.userProfilesCache[userId];
    }

    // Fetch from Firestore
    try {
      console.log(`[Cache] Fetching profile from Firestore for: ${userId}`);
      const userDoc = await window.getDoc(window.doc(window.db, 'user_profiles', userId));

      if (userDoc.exists()) {
        const userData = userDoc.data();
        const profile = {
          displayName: userData.displayName || userData.name || 'User',
          name: userData.name || userData.displayName || 'User',
          email: userData.email || '',
          avatar: userData.photoURL || userData.avatar || userData.profilePicture || null,
          photoURL: userData.photoURL || userData.avatar || userData.profilePicture || null,
          profilePicture: userData.profilePicture || userData.photoURL || userData.avatar || null,
          status: userData.status || 'offline',
          username: userData.username || ''
        };

        // Store in cache
        this.userProfilesCache[userId] = profile;
        console.log(`[Cache] ✅ Cached profile for: ${userId}`, profile);

        return profile;
      } else {
        console.warn(`[Cache] User profile not found in Firestore: ${userId}`);
        // Return fallback (null avatar to trigger initials in formatMessage)
        const fallback = {
          displayName: 'User',
          name: 'User',
          email: '',
          avatar: null,
          photoURL: null,
          profilePicture: null,
          status: 'offline'
        };
        this.userProfilesCache[userId] = fallback;
        return fallback;
      }
    } catch (error) {
      console.error(`[Cache] Error fetching user profile for ${userId}:`, error);
      // Return fallback on error (null avatar to trigger initials)
      const fallback = {
        displayName: 'User',
        name: 'User',
        email: '',
        avatar: null,
        photoURL: null,
        profilePicture: null,
        status: 'offline'
      };
      return fallback;
    }
  },

  /**
   * Clear user profile cache (useful for logout or refresh)
   */
  clearUserProfileCache() {
    this.userProfilesCache = {};
    console.log('[Cache] User profile cache cleared');
  },

  // ============================================================
  // REAL-TIME SIDEBAR UPDATES
  // ============================================================

  /**
   * Setup real-time listeners for sidebar updates
   * - Last message updates for rooms and chats
   * - User online/offline status
   * - Room member count changes
   */
  setupSidebarRealTimeListeners() {
    console.log('[Sidebar] Setting up real-time listeners...');

    // Clean up existing listeners
    this.cleanupSidebarListeners();

    // Listen for last messages in all rooms
    this.data.rooms.forEach(room => {
      this.listenForLastMessage('room', room.id);
    });

    // Listen for last messages in all chats
    this.data.chats.forEach(chat => {
      this.listenForLastMessage('dm', chat.id);
      // Also listen for user status if it's a DM
      if (chat.userId) {
        this.listenForUserStatus(chat.userId, chat.id);
      }
    });

    console.log('[Sidebar] ✅ Real-time listeners setup complete');
  },

  /**
   * Listen for last message in a thread and update sidebar
   */
  listenForLastMessage(threadType, threadId) {
    if (!window.rtdb || !window.ref || !window.onValue) {
      console.warn('[Sidebar] RTDB not available for listening');
      return;
    }

    const threadPath = threadType === 'room'
      ? `rooms/${threadId}/messages`
      : `dms/${threadId}/messages`;

    const messagesRef = window.ref(window.rtdb, threadPath);

    // Query for last message (limitToLast 1)
    const lastMessageQuery = window.query(messagesRef, window.orderByChild('createdAt'), window.limitToLast(1));

    const unsubscribe = window.onValue(lastMessageQuery, (snapshot) => {
      if (snapshot.exists()) {
        const messages = [];
        snapshot.forEach((childSnapshot) => {
          messages.push(childSnapshot.val());
        });

        const lastMessage = messages[messages.length - 1];
        if (lastMessage) {
          console.log(`[Sidebar] Last message updated for ${threadType}:${threadId}:`, lastMessage);
          this.updateSidebarLastMessage(threadType, threadId, lastMessage);
        }
      }
    });

    // Store listener for cleanup
    this.sidebarListeners.push({ type: 'lastMessage', threadType, threadId, unsubscribe });
  },

  /**
   * Listen for user online/offline status
   */
  listenForUserStatus(userId, chatId) {
    if (!window.rtdb || !window.ref || !window.onValue) {
      console.warn('[Sidebar] RTDB not available for user status');
      return;
    }

    const userStatusRef = window.ref(window.rtdb, `users/${userId}/status`);

    const unsubscribe = window.onValue(userStatusRef, (snapshot) => {
      if (snapshot.exists()) {
        const status = snapshot.val();
        console.log(`[Sidebar] Status updated for user ${userId}:`, status);
        this.updateSidebarUserStatus(chatId, status);
      }
    });

    // Store listener for cleanup
    this.sidebarListeners.push({ type: 'userStatus', userId, chatId, unsubscribe });
  },

  /**
   * Update last message in sidebar for a thread
   */
  updateSidebarLastMessage(threadType, threadId, lastMessage) {
    // Update in data object
    if (threadType === 'room') {
      const room = this.data.rooms.find(r => r.id === threadId);
      if (room) {
        room.lastMessage = this.formatLastMessageForSidebar(lastMessage);
        // Update DOM
        this.updateRoomInSidebar(room);
      }
    } else if (threadType === 'dm') {
      const chat = this.data.chats.find(c => c.id === threadId);
      if (chat) {
        chat.lastMessage = this.formatLastMessageForSidebar(lastMessage);
        // Update DOM
        this.updateChatInSidebar(chat);
      }
    }
  },

  /**
   * Update user status in sidebar for a chat
   */
  updateSidebarUserStatus(chatId, status) {
    const chat = this.data.chats.find(c => c.id === chatId);
    if (chat) {
      chat.status = status;
      // Update DOM
      this.updateChatInSidebar(chat);
    }
  },

  /**
   * Format last message for sidebar display
   */
  formatLastMessageForSidebar(message) {
    if (!message) return 'No messages';

    if (message.image) return '📷 Image';
    if (message.video) return '🎥 Video';
    if (message.file) return '📎 File';
    if (message.text) return message.text;
    return 'Message';
  },

  /**
   * Update a single room card in sidebar DOM
   */
  updateRoomInSidebar(room) {
    const roomButton = document.querySelector(`[data-room-id="${room.id}"]`);
    if (!roomButton) return;

    const isActive = this.currentView === room.id;

    // Re-render the button
    const newHTML = `
      <button 
        type="button"
        data-room-id="${room.id}"
        aria-current="${isActive ? 'true' : 'false'}"
        aria-label="Open ${room.name} room, ${room.members || 0} members${room.unread > 0 ? `, ${room.unread} unread messages` : ''}"
        class="group flex items-center justify-between rounded-lg px-3 py-2 border ${isActive ? 'border-slate-400/20 bg-slate-500/10 hover:bg-slate-500/15' : 'border-white/10 hover:bg-slate-800/10'} transition w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <div class="inline-flex items-center justify-center h-[32px] w-[32px] rounded-lg bg-slate-700/50 text-slate-300 font-semibold text-base flex-shrink-0 border border-white/10" aria-hidden="true">
            ${room.icon === '#' ? '#' : room.icon || '#'}
          </div>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-slate-${isActive ? '100' : '200'} text-sm truncate" style="font-weight: 600;">${this.escapeHtml(room.name)}</span>
            <span class="text-xs text-slate-500 truncate">${this.escapeHtml(this.formatLastMessage(room.lastMessage))}</span>
          </div>
        </div>
        ${room.unread > 0 ? `<span class="text-xs rounded-full bg-slate-500/20 text-slate-300 px-2 py-1 border border-slate-400/20 unread min-w-[24px] text-center flex-shrink-0" style="font-weight: 600;" aria-label="${room.unread} unread">${room.unread}</span>` : ''}
      </button>
    `;

    roomButton.outerHTML = newHTML;

    // Re-attach event listener
    const newButton = document.querySelector(`[data-room-id="${room.id}"]`);
    if (newButton) {
      newButton.addEventListener('click', () => this.navigateTo('room', room.id));
    }
  },

  /**
   * Update a single chat card in sidebar DOM
   */
  updateChatInSidebar(chat) {
    const chatButton = document.querySelector(`[data-chat-id="${chat.id}"]`);
    if (!chatButton) return;

    const isActive = this.currentView === chat.id;

    // Re-render the button
    const newHTML = `
      <button 
        type="button"
        data-chat-id="${chat.id}"
        aria-current="${isActive ? 'true' : 'false'}"
        aria-label="Open chat with ${chat.name}, ${chat.status || 'offline'}${chat.unread > 0 ? `, ${chat.unread} unread messages` : ''}"
        class="group flex items-center justify-between rounded-lg px-3 py-2 border ${isActive ? 'border-slate-400/20 bg-slate-500/10 hover:bg-slate-500/15' : 'border-white/10 hover:bg-slate-800/10'} transition w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <img src="${chat.avatar || 'https://via.placeholder.com/120'}" class="h-8 w-8 rounded-lg object-cover ring-1 ring-white/10 flex-shrink-0" alt="">
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-slate-200 text-sm truncate" style="font-weight: 600;">${this.escapeHtml(chat.name)}</span>
            <span class="text-xs text-slate-500 truncate">${this.escapeHtml(this.formatLastMessage(chat.lastMessage))}</span>
          </div>
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <span class="h-2 w-2 rounded-full bg-${chat.status === 'online' ? 'emerald' : 'rose'}-400" aria-hidden="true"></span>
          ${chat.unread > 0 ? `<span class="text-xs rounded-full bg-slate-500/20 text-slate-300 px-2 py-1 border border-slate-400/20 unread min-w-[24px] text-center" style="font-weight: 600;" aria-label="${chat.unread} unread">${chat.unread}</span>` : ''}
        </div>
      </button>
    `;

    chatButton.outerHTML = newHTML;

    // Re-attach event listener
    const newButton = document.querySelector(`[data-chat-id="${chat.id}"]`);
    if (newButton) {
      newButton.addEventListener('click', () => this.navigateTo('chat', chat.id));
    }
  },

  /**
   * Clean up all sidebar listeners
   */
  cleanupSidebarListeners() {
    console.log(`[Sidebar] Cleaning up ${this.sidebarListeners.length} listeners`);
    this.sidebarListeners.forEach(listener => {
      if (listener.unsubscribe) {
        listener.unsubscribe();
      }
    });
    this.sidebarListeners = [];
  },

  // Render sidebar items
  renderSidebar() {
    // Render rooms
    const roomsList = document.getElementById('roomsList');
    if (!roomsList) return; // Guard against missing element

    // Add ARIA label to rooms list container
    roomsList.setAttribute('aria-label', 'Room list');

    // Check if we have rooms to display
    if (this.data.rooms.length === 0) {
      roomsList.innerHTML = `
        <div class="px-3 py-6 text-center text-slate-500 text-base">
          No rooms available
        </div>
      `;
    } else {
      roomsList.innerHTML = this.data.rooms.map(room => {
        const isActive = this.currentView === room.id;
        return `
          <button 
            type="button"
            data-room-id="${room.id}"
            aria-current="${isActive ? 'true' : 'false'}"
            aria-label="Open ${room.name} room, ${room.members || 0} members${room.unread > 0 ? `, ${room.unread} unread messages` : ''}"
            class="group flex items-center justify-between rounded-lg px-3 py-2 border ${isActive ? 'border-slate-400/20 bg-slate-500/10 hover:bg-slate-500/15' : 'border-white/10 hover:bg-slate-800/10'} transition w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <div class="inline-flex items-center justify-center h-[32px] w-[32px] rounded-lg bg-slate-700/50 text-slate-300 font-semibold text-base flex-shrink-0 border border-white/10" aria-hidden="true">
                ${room.icon === '#' ? '#' : room.icon || '#'}
              </div>
              <div class="flex flex-col min-w-0 flex-1">
                <span class="text-slate-${isActive ? '100' : '200'} text-sm truncate" style="font-weight: 600;">${this.escapeHtml(room.name)}</span>
                <span class="text-xs text-slate-500 truncate">${Array.isArray(room.members) ? room.members.length : 0} members</span>
              </div>
            </div>
            ${room.unread > 0 ? `<span class="text-xs rounded-full bg-slate-500/20 text-slate-300 px-2 py-1 border border-slate-400/20 unread min-w-[24px] text-center flex-shrink-0" style="font-weight: 600;" aria-label="${room.unread} unread">${room.unread}</span>` : ''}
          </button>
        `;
      }).join('');
    }

    // Render chats
    const chatsList = document.getElementById('chatsList');
    if (!chatsList) return; // Guard against missing element

    // Add ARIA label to chats list container
    chatsList.setAttribute('aria-label', 'Direct messages list');

    // Check if we have chats to display
    if (this.data.chats.length === 0) {
      chatsList.innerHTML = `
        <div class="px-3 py-6 text-center text-slate-500 text-base">
          No chats available
        </div>
      `;
    } else {
      chatsList.innerHTML = this.data.chats.map(chat => {
        const isActive = this.currentView === chat.id;
        return `
          <button 
            type="button"
            data-chat-id="${chat.id}"
            aria-current="${isActive ? 'true' : 'false'}"
            aria-label="Open chat with ${chat.name}, ${chat.status || 'offline'}${chat.unread > 0 ? `, ${chat.unread} unread messages` : ''}"
            class="group flex items-center justify-between rounded-lg px-3 py-2 border ${isActive ? 'border-slate-400/20 bg-slate-500/10 hover:bg-slate-500/15' : 'border-white/10 hover:bg-slate-800/10'} transition w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <img src="${chat.avatar || 'https://via.placeholder.com/120'}" class="h-8 w-8 rounded-lg object-cover ring-1 ring-white/10 flex-shrink-0" alt="">
              <div class="flex flex-col min-w-0 flex-1">
                <span class="text-slate-200 text-sm truncate" style="font-weight: 600;">${this.escapeHtml(chat.name)}</span>
                <span class="text-xs text-slate-500 truncate">${this.escapeHtml(chat.statusText || this.formatLastMessage(chat.lastMessage))}</span>
              </div>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="h-2 w-2 rounded-full bg-${chat.status === 'online' ? 'emerald' : 'rose'}-400" aria-hidden="true"></span>
              ${chat.unread > 0 ? `<span class="text-xs rounded-full bg-slate-500/20 text-slate-300 px-2 py-1 border border-slate-400/20 unread min-w-[24px] text-center" style="font-weight: 600;" aria-label="${chat.unread} unread">${chat.unread}</span>` : ''}
            </div>
          </button>
        `;
      }).join('');
    }

    // Attach event listeners to room and chat buttons
    this.attachSidebarListeners();
  },

  /**
   * Format last message for sidebar display
   * Shows "Image", "Video", "File" for media messages
   */
  formatLastMessage(lastMessage) {
    if (!lastMessage) return 'No messages';

    // If lastMessage is an object (from Firebase)
    if (typeof lastMessage === 'object') {
      if (lastMessage.image) return '📷 Image';
      if (lastMessage.video) return '🎥 Video';
      if (lastMessage.file) return '📎 File';
      if (lastMessage.text) return lastMessage.text;
      return 'Message';
    }

    // If it's a string, return as-is
    return lastMessage;
  },

  /**
   * Attach event listeners to sidebar buttons (called after renderSidebar)
   */
  attachSidebarListeners() {
    // Room buttons
    const roomButtons = document.querySelectorAll('[data-room-id]');
    roomButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        const roomId = e.currentTarget.getAttribute('data-room-id');
        this.navigateTo('room', roomId);
      });
    });

    // Chat buttons
    const chatButtons = document.querySelectorAll('[data-chat-id]');
    chatButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        const chatId = e.currentTarget.getAttribute('data-chat-id');
        this.navigateTo('chat', chatId);
      });
    });
  },

  // Get icon SVG
  getIconSvg(icon, addAriaHidden = false) {
    const ariaAttr = addAriaHidden ? ' aria-hidden="true"' : '';
    const icons = {
      layout: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" class="text-slate-300 group-hover:text-slate-300 transition" style="stroke-width:1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"${ariaAttr}><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18"></path><path d="M9 21V9"></path></svg>`,
      code: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" class="text-slate-300 group-hover:text-slate-300 transition" style="stroke-width:1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"${ariaAttr}><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path></svg>`
    };
    return icons[icon] || '';
  },

  // Show welcome screen
  showWelcome() {
    this.currentView = null;

    document.getElementById('topBarContent').innerHTML = `
      <div class="flex items-center justify-between w-full h-full">
        <div class="flex items-center gap-4 flex-1 min-w-0">
          <div class="flex flex-col justify-center">
            <div class="text-slate-100 text-lg leading-tight" style="font-weight: 600; letter-spacing: -0.02em;">SINK</div>
            <div class="text-xs text-slate-400 leading-tight">
              <span class="text-slate-500">Select a room or chat to start messaging</span>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('mainContent').innerHTML = `
      <section class="flex flex-col h-full overflow-hidden">
        <div class="flex-1 flex items-center justify-center px-6">
          <div class="text-center max-w-md">
            <div class="mb-4">
              <img src="logo.png" alt="SINK Logo" class="h-16 w-auto object-contain mx-auto mb-3 opacity-50">
            </div>
            <h2 class="text-2xl text-slate-300 mb-2" style="font-weight: 600;">Welcome to SINK</h2>
            <p class="text-sm text-slate-500 leading-relaxed">Select a room or chat from the sidebar to start messaging.</p>
          </div>
        </div>
      </section>
    `;
    this.renderSidebar();
  },

  // Helper: Format Firebase message to app message format
  async formatMessage(rawMessage) {
    // Get current user from window.auth
    const currentUser = window.auth?.currentUser;
    if (!currentUser) {
      console.warn('[formatMessage] No current user found');
      return null;
    }

    // Determine if message is from current user
    const isOutgoing = rawMessage.senderId === currentUser.uid;

    // Fetch sender's profile from cache (for BOTH incoming AND outgoing messages)
    let senderProfile = null;
    if (rawMessage.senderId) {
      // Check cache first - if exists, no async call needed
      if (this.userProfilesCache[rawMessage.senderId]) {
        senderProfile = this.userProfilesCache[rawMessage.senderId];
      } else {
        // Only fetch if not in cache - this maintains order for first load
        senderProfile = await this.getUserProfile(rawMessage.senderId);
      }
    }

    // Ensure createdAt is a number (timestamp)
    let createdAtTimestamp;
    if (typeof rawMessage.createdAt === 'number') {
      createdAtTimestamp = rawMessage.createdAt;
    } else if (rawMessage.createdAt) {
      createdAtTimestamp = new Date(rawMessage.createdAt).getTime();
    } else {
      createdAtTimestamp = Date.now();
    }

    // Determine avatar (prefer cached profile, then rawMessage.senderAvatar from placeholder, then fallback)
    // NOTE: Use userId hash for consistent color instead of 'random' to avoid color changes
    const getUserInitials = (name) => {
      if (!name) return 'U';
      return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    };

    const displayName = senderProfile?.displayName || senderProfile?.name || rawMessage.senderName || 'User';
    const initials = getUserInitials(displayName);

    // Use senderId for consistent color (hash it to get same color for same user)
    const getColorFromId = (id) => {
      if (!id) return '3498db';
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
      }
      const colors = ['3498db', '2ecc71', 'e74c3c', 'f39c12', '9b59b6', '1abc9c', 'e67e22', '34495e'];
      return colors[Math.abs(hash) % colors.length];
    };

    const avatarUrl = senderProfile?.avatar ||
      senderProfile?.photoURL ||
      senderProfile?.profilePicture ||
      rawMessage.senderAvatar ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=${getColorFromId(rawMessage.senderId)}&color=fff`;

    return {
      id: rawMessage.id,
      type: isOutgoing ? 'outgoing' : 'incoming',
      sender: senderProfile?.displayName || senderProfile?.name || rawMessage.senderName || 'Unknown',
      text: rawMessage.text || '',
      time: this.formatMessageTime(createdAtTimestamp),
      createdAt: createdAtTimestamp, // Store as number for sorting
      avatar: avatarUrl,
      image: rawMessage.image?.url || rawMessage.image || '',
      video: rawMessage.video?.url || rawMessage.video || '',
      file: rawMessage.file
    };
  },

  // ============================================================
  // MESSAGE QUEUE PROCESSING - Maintain chronological order
  // ============================================================

  /**
   * Add message to processing queue and process in order
   */
  async queueMessage(rawMessage, callback) {
    // Add to queue with timestamp
    this.messageQueue.push({ rawMessage, callback, timestamp: rawMessage.createdAt || Date.now() });

    // Sort queue by timestamp to maintain order
    this.messageQueue.sort((a, b) => a.timestamp - b.timestamp);

    // Process queue if not already processing
    if (!this.isProcessingQueue) {
      await this.processMessageQueue();
    }
  },

  /**
   * Process messages from queue sequentially
   */
  async processMessageQueue() {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const { rawMessage, callback } = this.messageQueue.shift();

      try {
        // Format message (awaits profile fetch if needed)
        const formattedMessage = await this.formatMessage(rawMessage);

        if (formattedMessage && callback) {
          // Call the callback with formatted message
          callback(formattedMessage);
        }
      } catch (error) {
        console.error('[Queue] Error processing message:', error);
      }
    }

    this.isProcessingQueue = false;
  },

  // Helper: Format timestamp to time string (h:mm A)
  formatMessageTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes < 10 ? '0' + minutes : minutes;
    return `${formattedHours}:${formattedMinutes} ${ampm}`;
  },

  /**
   * Helper: Format timestamp to day string
   * Returns 'Today', 'Yesterday', or 'DD/MM/YYYY'
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} Formatted day string
   */
  formatMessageDay(timestamp) {
    if (!timestamp) return '';

    const messageDate = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Reset time to midnight for comparison
    const messageMidnight = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const yesterdayMidnight = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());

    if (messageMidnight.getTime() === todayMidnight.getTime()) {
      return 'Today';
    } else if (messageMidnight.getTime() === yesterdayMidnight.getTime()) {
      return 'Yesterday';
    } else {
      // Format as DD/MM/YYYY
      const day = String(messageDate.getDate()).padStart(2, '0');
      const month = String(messageDate.getMonth() + 1).padStart(2, '0');
      const year = messageDate.getFullYear();
      return `${day}/${month}/${year}`;
    }
  },

  /**
   * Helper: Format timestamp to time string (h:mm A)
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} Formatted time string
   */
  formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes < 10 ? '0' + minutes : minutes;
    return `${formattedHours}:${formattedMinutes} ${ampm}`;
  },

  /**
   * Helper: Format file size in bytes to human-readable format
   * @param {number} bytes - File size in bytes
   * @returns {string} Formatted size string (e.g., "1.5 MB", "245 KB")
   */
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  },

  // Open a room
  async openRoom(roomId) {
    console.log(`[openRoom] Opening room: ${roomId}`);
    this.currentView = roomId;
    const room = this.data.rooms.find(r => r.id === roomId);

    if (!room) {
      console.error('[openRoom] Room not found:', roomId);
      return;
    }

    const threadKey = `room:${roomId}`;
    const roomTitle = roomId === 'general'
      ? `<span class="text-slate-300 font-semibold mr-2">#</span>${room.name}`
      : `${room.name}`;

    // PRE-FETCH: User profiles for all members to avoid async delays in messages
    if (Array.isArray(room.members) && room.members.length > 0) {
      console.log('[openRoom] Pre-fetching user profiles for', room.members.length, 'members');
      await Promise.all(room.members.map(userId => this.getUserProfile(userId)));
      console.log('[openRoom] ✅ User profiles cached');
    }

    // Fetch member names and status from RTDB using UIDs
    let membersWithStatus = [];
    if (Array.isArray(room.members) && room.members.length > 0) {
      try {
        // Fetch member data from RTDB
        const memberDataPromises = room.members.map(async (uid) => {
          try {
            // Use firebaseService helper
            if (window.firebaseService && window.firebaseService.getUserFromRTDB) {
              const userData = await window.firebaseService.getUserFromRTDB(uid);

              if (userData) {
                return {
                  name: userData.name || userData.username || 'Unknown',
                  status: userData.status || 'offline'
                };
              }
            }

            // Fallback: direct RTDB fetch
            if (window.rtdb && window.ref && window.get) {
              const rtdbUserRef = window.ref(window.rtdb, `users/${uid}`);
              const rtdbUserSnap = await window.get(rtdbUserRef);

              if (rtdbUserSnap.exists()) {
                const userData = rtdbUserSnap.val();
                return {
                  name: userData.name || userData.username || 'Unknown',
                  status: userData.status || 'offline'
                };
              }
            }

            console.warn('[openRoom] Could not fetch user data for:', uid);
            return { name: 'Unknown', status: 'offline' };
          } catch (error) {
            console.error('[openRoom] Error fetching member:', uid, error);
            return { name: 'Unknown', status: 'offline' };
          }
        });

        membersWithStatus = await Promise.all(memberDataPromises);
      } catch (error) {
        console.error('[openRoom] Error fetching members:', error);
        membersWithStatus = room.members.map(uid => ({ name: uid, status: 'offline' }));
      }
    }

    // Update header - Android LinearLayout style structure
    document.getElementById('topBarContent').innerHTML = `
      <div class="flex items-center w-full h-full">
        <!-- Vertical LinearLayout (Title + Subtitle) -->
        <div class="flex flex-col justify-center min-w-0">
          <div class="text-slate-100 text-lg leading-tight" style="font-weight: 600; letter-spacing: -0.02em;">${roomTitle}</div>
          <div class="text-xs text-slate-400 leading-tight truncate">
            <span class="mr-2 text-slate-500">Members:</span>
            ${(() => {
        if (membersWithStatus.length > 0) {
          return membersWithStatus.map(member => {
            const statusColor = member.status === 'online' ? 'emerald' : 'red';
            return `<span class="mr-2"><span class="text-${statusColor}-400">•</span> ${this.escapeHtml(member.name)}</span>`;
          }).join('');
        }
        return '<span>No members</span>';
      })()}
          </div>
        </div>
        
        <!-- Spacer (flex-1 to push buttons to end) -->
        <div class="flex-1"></div>
        
        <!-- Action Buttons (end aligned) -->
        <div class="flex items-center gap-2 flex-shrink-0">
          ${roomId === 'general' ? `
            <button class="h-10 w-10 flex items-center justify-center rounded-lg border border-white/10 bg-slate-800/50 hover:bg-slate-700/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </button>
          ` : `
            <button class="h-10 w-10 flex items-center justify-center rounded-lg border border-white/10 bg-slate-800/50 hover:bg-slate-700/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M16 11h6"></path>
                <path d="M19 8v6"></path>
              </svg>
            </button>
            <button class="h-10 w-10 flex items-center justify-center rounded-lg border border-white/10 bg-slate-800/50 hover:bg-slate-700/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </button>
          `}
        </div>
      </div>
    `;

    // STEP 1: Detach previous listener if exists
    if (this.currentThreadListener) {
      console.log('[openRoom] Detaching previous thread listener');
      if (window.firebaseService && window.firebaseService.closeMessageListener) {
        try {
          window.firebaseService.closeMessageListener(this.currentThreadListener);
          this.currentThreadListener = null;
        } catch (error) {
          console.error('[openRoom] Error closing previous listener:', error);
        }
      }
    }

    // STEP 2: Initialize messages cache for this thread if not exists
    if (!this.messagesCache[threadKey]) {
      this.messagesCache[threadKey] = [];
    }

    // STEP 3: Show loading placeholder (only if cache is empty)
    if (this.messagesCache[threadKey].length === 0) {
      console.log('[openRoom] Showing loading placeholder');
      this.renderChatLoading(room.name);
    } else {
      // Show cached messages immediately
      console.log(`[openRoom] Rendering ${this.messagesCache[threadKey].length} cached messages`);
      this.renderChat(this.messagesCache[threadKey], room.name);
    }

    // STEP 4: Attach new listener for real-time messages
    console.log('[openRoom] Attaching listener for room:', roomId);
    try {
      if (!window.firebaseService || !window.firebaseService.listenForMessages) {
        console.error('[openRoom] firebaseService.listenForMessages not available');
        return;
      }

      this.currentThreadListener = window.firebaseService.listenForMessages(
        'room',
        roomId,
        async (rawMessage) => {
          console.log('[openRoom] ✉️ Received message:', rawMessage.id);

          // ================================================================
          // STEP 1: Deduplicate - Check if already processed
          // ================================================================
          if (!this.processedMessageIds[threadKey]) {
            this.processedMessageIds[threadKey] = new Set();
          }

          if (this.processedMessageIds[threadKey].has(rawMessage.id)) {
            console.log('[openRoom] ⏭️ Already processed, skipping:', rawMessage.id);
            return;
          }

          // ================================================================
          // STEP 2: Check if this is OUR optimistic placeholder coming back
          // ================================================================
          const matchId = rawMessage.tempId || rawMessage.id;

          if (this.pendingMessages[matchId]) {
            console.log('[openRoom] 🔄 Our sent message confirmed by Firebase:', matchId);

            // Just update status - placeholder already rendered
            const existingBubble = document.querySelector(`[data-temp-id="${matchId}"]`);
            if (existingBubble) {
              existingBubble.setAttribute('data-message-id', rawMessage.id);
              existingBubble.setAttribute('data-firebase-id', rawMessage.id);
              existingBubble.setAttribute('data-status', 'delivered');
            }

            // Update cache with full data
            const formattedMessage = await this.formatMessage(rawMessage);
            const cacheIndex = this.messagesCache[threadKey].findIndex(m => m.tempId === matchId || m.id === matchId);
            if (cacheIndex !== -1) {
              this.messagesCache[threadKey][cacheIndex] = formattedMessage;
            }

            delete this.pendingMessages[matchId];
            this.processedMessageIds[threadKey].add(rawMessage.id);
            return; // Don't render duplicate
          }

          // ================================================================
          // STEP 3: This is a NEW message (from another user or initial load)
          // ================================================================

          // Check if already in cache (initial load from listener)
          const existsInCache = this.messagesCache[threadKey].some(m => m.id === rawMessage.id);
          if (existsInCache) {
            console.log('[openRoom] Already in cache, skipping render:', rawMessage.id);
            this.processedMessageIds[threadKey].add(rawMessage.id);
            return;
          }

          // Format message
          const formattedMessage = await this.formatMessage(rawMessage);
          if (!formattedMessage) {
            console.warn('[openRoom] Failed to format message');
            return;
          }

          // Add to cache
          this.messagesCache[threadKey].push(formattedMessage);

          // Sort by timestamp
          this.messagesCache[threadKey].sort((a, b) => {
            const timeA = typeof a.createdAt === 'number' ? a.createdAt : new Date(a.createdAt || 0).getTime();
            const timeB = typeof b.createdAt === 'number' ? b.createdAt : new Date(b.createdAt || 0).getTime();
            return timeA - timeB;
          });

          // Mark as processed
          this.processedMessageIds[threadKey].add(rawMessage.id);

          console.log(`[openRoom] Added new message. Cache now: ${this.messagesCache[threadKey].length}`);

          // Re-render if viewing this room
          if (this.currentView === roomId) {
            console.log('[openRoom] Re-rendering with', this.messagesCache[threadKey].length, 'messages');
            this.renderChat(this.messagesCache[threadKey], room.name);
          }
        }
      );

      console.log('[openRoom] ✅ Listener attached successfully');
    } catch (error) {
      console.error('[openRoom] ❌ Error attaching listener:', error);
    }

    // Mark thread as read for current user
    const currentUser = window.auth?.currentUser;
    if (currentUser && window.firebaseService && window.firebaseService.markThreadRead) {
      try {
        await window.firebaseService.markThreadRead('room', roomId, currentUser.uid);
        console.log('[openRoom] ✅ Marked room as read');

        // Update unread count in sidebar
        const roomData = this.data.rooms.find(r => r.id === roomId);
        if (roomData) {
          roomData.unread = 0;
          this.renderSidebar();
        }
      } catch (error) {
        console.error('[openRoom] Error marking room as read:', error);
      }
    }

    this.renderSidebar();
  },

  // Open a chat
  async openChat(chatId) {
    console.log(`[openChat] Opening chat: ${chatId}`);
    this.currentView = chatId;
    const chat = this.data.chats.find(c => c.id === chatId);

    if (!chat) {
      console.error('[openChat] Chat not found:', chatId);
      return;
    }

    const threadKey = `dm:${chatId}`;

    // PRE-FETCH: User profile for chat participant to avoid async delays
    if (chat.userId) {
      console.log('[openChat] Pre-fetching user profile for:', chat.userId);
      await this.getUserProfile(chat.userId);
      console.log('[openChat] ✅ User profile cached');
    }

    // Update header - Android LinearLayout style structure
    document.getElementById('topBarContent').innerHTML = `
      <div class="flex items-center w-full h-full">
        <!-- Vertical LinearLayout (Title + Subtitle) -->
        <div class="flex flex-col justify-center min-w-0">
          <div class="text-slate-100 text-lg leading-tight" style="font-weight: 600; letter-spacing: -0.02em;">${chat.name}</div>
          <div class="text-xs text-slate-400 leading-tight">
            <span class="text-slate-500">Direct Message</span>
          </div>
        </div>
        
        <!-- Spacer (flex-1 to push buttons to end) -->
        <div class="flex-1"></div>
        
        <!-- Action Buttons (end aligned) -->
        <div class="flex items-center gap-2 flex-shrink-0">
          <button class="h-10 w-10 flex items-center justify-center rounded-lg border border-white/10 bg-slate-800/50 hover:bg-slate-700/50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
        </div>
      </div>
    `;

    // STEP 1: Detach previous listener if exists
    if (this.currentThreadListener) {
      console.log('[openChat] Detaching previous thread listener');
      if (window.firebaseService && window.firebaseService.closeMessageListener) {
        try {
          window.firebaseService.closeMessageListener(this.currentThreadListener);
          this.currentThreadListener = null;
        } catch (error) {
          console.error('[openChat] Error closing previous listener:', error);
        }
      }
    }

    // STEP 2: Initialize messages cache for this thread if not exists
    if (!this.messagesCache[threadKey]) {
      this.messagesCache[threadKey] = [];
    }

    // STEP 3: Show loading placeholder (only if cache is empty)
    if (this.messagesCache[threadKey].length === 0) {
      console.log('[openChat] Showing loading placeholder');
      this.renderChatLoading(chat.name);
    } else {
      // Show cached messages immediately
      console.log(`[openChat] Rendering ${this.messagesCache[threadKey].length} cached messages`);
      this.renderChat(this.messagesCache[threadKey], chat.name);
    }

    // STEP 4: Attach new listener for real-time messages
    console.log('[openChat] Attaching listener for chat:', chatId);
    try {
      if (!window.firebaseService || !window.firebaseService.listenForMessages) {
        console.error('[openChat] firebaseService.listenForMessages not available');
        return;
      }

      this.currentThreadListener = window.firebaseService.listenForMessages(
        'dm',
        chatId,
        async (rawMessage) => {
          console.log('[openChat] ✉️ Received message:', rawMessage.id);

          // ================================================================
          // STEP 1: Deduplicate - Check if already processed
          // ================================================================
          if (!this.processedMessageIds[threadKey]) {
            this.processedMessageIds[threadKey] = new Set();
          }

          if (this.processedMessageIds[threadKey].has(rawMessage.id)) {
            console.log('[openChat] ⏭️ Already processed, skipping:', rawMessage.id);
            return;
          }

          // ================================================================
          // STEP 2: Check if this is OUR optimistic placeholder coming back
          // ================================================================
          const matchId = rawMessage.tempId || rawMessage.id;

          if (this.pendingMessages[matchId]) {
            console.log('[openChat] 🔄 Our sent message confirmed by Firebase:', matchId);

            // Just update status - placeholder already rendered
            const existingBubble = document.querySelector(`[data-temp-id="${matchId}"]`);
            if (existingBubble) {
              existingBubble.setAttribute('data-message-id', rawMessage.id);
              existingBubble.setAttribute('data-firebase-id', rawMessage.id);
              existingBubble.setAttribute('data-status', 'delivered');
            }

            // Update cache with full data
            const formattedMessage = await this.formatMessage(rawMessage);
            const cacheIndex = this.messagesCache[threadKey].findIndex(m => m.tempId === matchId || m.id === matchId);
            if (cacheIndex !== -1) {
              this.messagesCache[threadKey][cacheIndex] = formattedMessage;
            }

            delete this.pendingMessages[matchId];
            this.processedMessageIds[threadKey].add(rawMessage.id);
            return; // Don't render duplicate
          }

          // ================================================================
          // STEP 3: This is a NEW message (from another user or initial load)
          // ================================================================

          // Check if already in cache (initial load from listener)
          const existsInCache = this.messagesCache[threadKey].some(m => m.id === rawMessage.id);
          if (existsInCache) {
            console.log('[openChat] Already in cache, skipping render:', rawMessage.id);
            this.processedMessageIds[threadKey].add(rawMessage.id);
            return;
          }

          // Format message
          const formattedMessage = await this.formatMessage(rawMessage);
          if (!formattedMessage) {
            console.warn('[openChat] Failed to format message');
            return;
          }

          // Add to cache
          this.messagesCache[threadKey].push(formattedMessage);

          // Sort by timestamp
          this.messagesCache[threadKey].sort((a, b) => {
            const timeA = typeof a.createdAt === 'number' ? a.createdAt : new Date(a.createdAt || 0).getTime();
            const timeB = typeof b.createdAt === 'number' ? b.createdAt : new Date(b.createdAt || 0).getTime();
            return timeA - timeB;
          });

          // Mark as processed
          this.processedMessageIds[threadKey].add(rawMessage.id);

          console.log(`[openChat] Added new message. Cache now: ${this.messagesCache[threadKey].length}`);

          // Re-render if viewing this chat
          if (this.currentView === chatId) {
            console.log('[openChat] Re-rendering with', this.messagesCache[threadKey].length, 'messages');
            this.renderChat(this.messagesCache[threadKey], chat.name);
          }
        }
      );

      console.log('[openChat] ✅ Listener attached successfully');
    } catch (error) {
      console.error('[openChat] ❌ Error attaching listener:', error);
    }

    // Mark thread as read for current user
    const currentUser = window.auth?.currentUser;
    if (currentUser && window.firebaseService && window.firebaseService.markThreadRead) {
      try {
        await window.firebaseService.markThreadRead('dm', chatId, currentUser.uid);
        console.log('[openChat] ✅ Marked chat as read');

        // Update unread count in sidebar
        const chatData = this.data.chats.find(c => c.id === chatId);
        if (chatData) {
          chatData.unread = 0;
          this.renderSidebar();
        }
      } catch (error) {
        console.error('[openChat] Error marking chat as read:', error);
      }
    }

    this.renderSidebar();
  },

  // Render chat loading placeholder
  renderChatLoading(chatName) {
    document.getElementById('mainContent').innerHTML = `
      <section class="flex flex-col h-full overflow-hidden">
        <div class="flex-1 flex items-center justify-center px-6">
          <div class="text-center">
            <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-slate-400 mb-4"></div>
            <div class="text-slate-400 text-sm">Loading messages...</div>
          </div>
        </div>
      </section>
    `;
  },

  // ========== MESSAGE RENDERING HELPERS ==========

  /**
   * Generate Firebase-style push ID for messages
   * Uses Firebase's algorithm: timestamp + random characters
   * Format: -OcGGVgjEt_uJe3XV_uu (similar to Firebase auto-generated IDs)
   * 
   * This ensures:
   * - Chronologically sortable
   * - Collision-resistant
   * - Compatible with Firebase naming
   * 
   * @returns {string} Firebase-style push ID
   */
  genTempId() {
    // Firebase push ID character set
    const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

    // Get current timestamp
    let now = new Date().getTime();
    const duplicateTime = (now === this._lastPushTime);
    this._lastPushTime = now;

    // Generate 8 characters from timestamp
    const timeStampChars = new Array(8);
    for (let i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }

    let id = timeStampChars.join('');

    // Add 12 random characters for uniqueness
    if (!duplicateTime) {
      for (let i = 0; i < 12; i++) {
        this._lastRandChars[i] = Math.floor(Math.random() * 64);
      }
    } else {
      // Increment random chars if same timestamp
      let i = 11;
      for (; i >= 0 && this._lastRandChars[i] === 63; i--) {
        this._lastRandChars[i] = 0;
      }
      this._lastRandChars[i]++;
    }

    for (let i = 0; i < 12; i++) {
      id += PUSH_CHARS.charAt(this._lastRandChars[i]);
    }

    return '-' + id; // Firebase IDs start with '-'
  },

  /**
   * Escape HTML special characters to prevent XSS attacks
   * 
   * WHY THIS PREVENTS XSS:
   * - Converts special HTML characters (&, <, >, ", ', /) into HTML entities
   * - Prevents user input from being interpreted as HTML/JavaScript code
   * - Example: "<script>alert('XSS')</script>" becomes "&lt;script&gt;alert('XSS')&lt;/script&gt;"
   *   which displays as text rather than executing
   * 
   * SERVER-SIDE VALIDATION STILL REQUIRED:
   * - Client-side escaping can be bypassed if attacker modifies the source code
   * - Server must validate and sanitize all input before storing in database
   * - Server should enforce Content Security Policy (CSP) headers
   * - Server should validate file uploads and limit file types
   * - Never trust client-side validation alone for security
   * 
   * @param {any} input - Input to escape (will be converted to string)
   * @returns {string} Escaped text safe for HTML insertion
   */
  escapeHtml(input) {
    // Handle non-string input by converting to string first
    const str = input == null ? '' : String(input);

    // Map of characters to their HTML entity equivalents
    const htmlEscapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };

    // Replace each special character with its entity
    return str.replace(/[&<>"'\/]/g, (char) => htmlEscapeMap[char]);
  },

  /**
   * Check if a URL is safe to use in src attributes
   * 
   * WHY THIS PREVENTS XSS:
   * - Blocks dangerous protocols like "javascript:" which can execute code
   * - Example: <img src="javascript:alert('XSS')"> would execute JavaScript
   * - Only allows http(s) and data:image/* URLs
   * 
   * @param {string} url - URL to validate
   * @returns {boolean} True if URL is safe, false otherwise
   */
  /**
   * Render a date separator message
   * Unit check: { type: 'date', text: 'Today' } → <div...>Today</div>
   * @param {Object} msg - Message object with text property
   * @returns {string} HTML string for date separator
   */
  messageDateHTML(msg) {
    const safeText = this.escapeHtml(msg.text || '');
    return `<div class="flex justify-center my-3 date-separator" role="separator" aria-label="Date: ${safeText}">
      <span class="text-xs text-slate-400 bg-slate-800/15 border border-white/10 px-3 py-1 rounded-full backdrop-blur-md" style="font-weight: 400;" aria-hidden="true">${safeText}</span>
    </div>`;
  },

  /**
   * Render a time separator message
   * Unit check: { type: 'time', text: '10:30 AM' } → <div...>10:30 AM</div>
   * @param {Object} msg - Message object with text property
   * @returns {string} HTML string for time separator
   */
  messageTimeHTML(msg) {
    const safeText = this.escapeHtml(msg.text || '');
    return `<div class="flex justify-center my-3" role="separator" aria-label="Time: ${safeText}">
      <span class="text-base text-slate-300 bg-slate-800/15 border border-white/10 px-3 py-1 rounded-full backdrop-blur-md" style="font-weight: 500;" aria-hidden="true">${safeText}</span>
    </div>`;
  },

  /**
   * Render an incoming message bubble
   * Unit check: { type: 'incoming', sender: 'Yash', time: '10:12 AM', text: 'Hello', avatar: 'url' }
   *   → <div class="mb-4"><div class="flex...">...</div></div>
   * @param {Object} msg - Message object with sender, time, text, avatar, and optional image/video/file
   * @returns {string} HTML string for incoming message
   */
  incomingMessageHTML(msg) {
    // Escape all user-provided text content
    const safeSender = this.escapeHtml(msg.sender || '');
    const safeTime = this.escapeHtml(msg.time || '');
    const safeText = msg.text ? this.escapeHtml(msg.text) : '';

    // Use default avatar if not provided
    const defaultAvatar = 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?q=80&w=120&auto=format&fit=crop';
    const avatar = msg.avatar || defaultAvatar;
    const image = msg.image || '';
    const video = msg.video || '';

    return `
    <div class="mb-4">
      <div class="flex items-end gap-3">
        <img src="${avatar}" class="h-10 w-10 rounded-full object-cover ring-1 ring-white/10" alt="avatar">
        <div class="max-w-[75%] ${image || video ? '' : 'min-w-[250px]'} rounded-2xl border border-white/10 bg-slate-900/70 backdrop-blur-md pt-3 px-3 pb-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs text-slate-400 mx-1">${safeSender}</span>
            <span class="text-xs text-slate-400 mx-1">${safeTime}</span>
          </div>
          ${safeText ? `<p class="text-slate-200 text-sm leading-relaxed mx-1 mb-2">${safeText}</p>` : ''}
          ${image ? `
            <div class="relative group -mx-3 -mb-2 ${safeText ? 'mt-1' : 'mt-3'}">
              <img src="${image}" alt="preview" class="w-full max-h-80 object-cover rounded-2xl" onerror="SinkApp.handleMediaError(this, 'image')">
              <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition"></div>
              <div class="absolute top-2 right-2 flex items-center gap-2">
                <button onclick="SinkApp.downloadMedia('${image}')" class="inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md px-3 py-3 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
          ${video ? `
            <div class="relative group -mx-3 -mb-2 mt-3">
              <video controls playsinline class="w-full max-h-80 object-cover rounded-2xl" src="${video}" onerror="SinkApp.handleMediaError(this, 'video')"></video>
              <div class="absolute top-2 right-2">
                <button onclick="SinkApp.downloadMedia('${video}')" class="inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md px-3 py-3 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
          ${msg.file ? `
            <div class="-mx-3 -mb-2 mt-3">
              <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-800/30 px-3 py-2.5">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-slate-400" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <path d="M14 2v6h6"></path>
                    </svg>
                  </div>
                  <div class="min-w-0">
                    <div class="text-slate-200 text-sm truncate">${this.escapeHtml(msg.file.name || 'File')}</div>
                    <div class="text-xs text-slate-500">${this.formatFileSize(msg.file.size || 0)}</div>
                  </div>
                </div>
                <button onclick="SinkApp.downloadMedia('${msg.file.url || '#'}')" class="flex-shrink-0 inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md p-2.5 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    </div>`;
  },

  /**
   * Render an outgoing message bubble
   * Unit check: { type: 'outgoing', time: '10:14 AM', text: 'Hello back' }
   *   → <div class="mb-4"><div class="flex...justify-end">...</div></div>
   * @param {Object} msg - Message object with time, text, and optional image/video/file
   * @returns {string} HTML string for outgoing message
   */
  outgoingMessageHTML(msg) {
    // Escape all user-provided text content
    const safeTime = this.escapeHtml(msg.time || '');
    const safeText = msg.text ? this.escapeHtml(msg.text) : '';
    const status = msg.status || 'delivered'; // sending | sent | delivered | failed

    // Use default avatar if not provided
    const defaultAvatar = 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?q=80&w=120&auto=format&fit=crop';
    const avatar = msg.avatar || defaultAvatar;
    const image = msg.image || '';
    const video = msg.video || '';

    return `
    <div class="mb-4" data-message-id="${msg.id}" data-temp-id="${msg.tempId || msg.id}" data-status="${status}">
      <div class="flex items-end gap-3 justify-end">
        <div class="max-w-[75%] ${image || video ? '' : 'min-w-[250px]'} rounded-2xl border border-white/10 bg-slate-700/20 backdrop-blur-md pt-3 px-3 pb-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs text-slate-400 mx-1">${safeTime}</span>
            <span class="text-xs text-slate-400 mx-1">You</span>
          </div>
          ${safeText ? `<p class="text-slate-200 text-sm leading-relaxed mx-1 mb-2">${safeText}</p>` : ''}
          ${image ? `
            <div class="relative group -mx-3 -mb-2 ${safeText ? 'mt-1' : 'mt-3'}">
              <img src="${image}" alt="preview" class="w-full max-h-80 object-cover rounded-2xl" onerror="SinkApp.handleMediaError(this, 'image')">
              <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition"></div>
              <div class="absolute top-2 right-2">
                <button onclick="SinkApp.downloadMedia('${image}')" class="inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md px-3 py-3 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
          ${video ? `
            <div class="relative -mx-3 -mb-2 mt-3">
              <video controls playsinline class="w-full max-h-80 bg-black/40 object-cover rounded-2xl" src="${video}" onerror="SinkApp.handleMediaError(this, 'video')"></video>
              <div class="absolute top-2 right-2">
                <button onclick="SinkApp.downloadMedia('${video}')" class="inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md px-3 py-3 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
          ${msg.file ? `
            <div class="-mx-3 -mb-2 mt-3">
              <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-800/30 px-3 py-2.5">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-slate-400" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <path d="M14 2v6h6"></path>
                    </svg>
                  </div>
                  <div class="min-w-0">
                    <div class="text-slate-200 text-sm truncate">${this.escapeHtml(msg.file.name || 'File')}</div>
                    <div class="text-xs text-slate-500">${this.formatFileSize(msg.file.size || 0)}</div>
                  </div>
                </div>
                <button onclick="SinkApp.downloadMedia('${msg.file.url || '#'}')" class="flex-shrink-0 inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md p-2.5 text-white hover:bg-slate-900/80 transition cursor-pointer">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7,10 12,15 17,10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                </button>
              </div>
            </div>
          ` : ''}
        </div>
        <img src="${avatar}" class="h-10 w-10 rounded-full object-cover ring-1 ring-white/10" alt="me">
      </div>
    </div>`;
  },

  /**
   * Render uploading message with circular progress overlay on actual image
   */
  uploadingMessageHTML(msg) {
    const safeTime = this.escapeHtml(msg.time || '');
    const safeText = msg.text ? this.escapeHtml(msg.text) : '';
    const isImage = msg.fileType?.startsWith('image/');
    const isVideo = msg.fileType?.startsWith('video/');
    const status = msg.status || 'uploading'; // uploading | sending | sent | delivered | failed

    // Default avatar
    const defaultAvatar = 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?q=80&w=120&auto=format&fit=crop';

    return `
    <div class="mb-4" data-message-id="${msg.id}" data-temp-id="${msg.tempId || msg.id}" data-status="${status}">
      <div class="flex items-end gap-3 justify-end">
        <div class="max-w-[75%] rounded-2xl border border-white/10 bg-slate-700/20 backdrop-blur-md pt-3 px-3 pb-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs text-slate-400 mx-1">${safeTime}</span>
            <span class="text-xs text-slate-400 mx-1">You</span>
          </div>
          ${safeText ? `<p class="text-slate-200 text-sm leading-relaxed mx-1 mb-2">${safeText}</p>` : ''}
          
          <!-- Image/Video Preview with Circular Progress Overlay -->
          <div class="relative -mx-3 -mb-2 ${safeText ? 'mt-1' : 'mt-3'}">
            ${isImage && msg.previewDataUrl ? `
              <!-- Actual image preview -->
              <img src="${msg.previewDataUrl}" alt="Uploading" class="w-full max-h-80 object-cover rounded-2xl">
              
              <!-- Progress overlay (centered on image) -->
              <div class="absolute inset-0 flex items-center justify-center bg-black/30 rounded-2xl">
                <svg class="w-24 h-24" viewBox="0 0 100 100">
                  <!-- Background circle -->
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.2)"
                    stroke-width="4"
                  />
                  <!-- Progress circle -->
                  <circle
                    class="upload-progress-circle"
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="url(#gradient-${msg.id})"
                    stroke-width="4"
                    stroke-linecap="round"
                    stroke-dasharray="${2 * Math.PI * 45}"
                    stroke-dashoffset="${2 * Math.PI * 45}"
                    transform="rotate(-90 50 50)"
                    style="transition: stroke-dashoffset 0.3s ease;"
                  />
                  <!-- Gradient definition -->
                  <defs>
                    <linearGradient id="gradient-${msg.id}" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
                      <stop offset="100%" style="stop-color:#06b6d4;stop-opacity:1" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            ` : isVideo ? `
              <!-- Video placeholder with progress -->
              <div class="w-full h-64 bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded-2xl flex items-center justify-center relative">
                <svg width="60" height="60" viewBox="0 0 24 24" fill="none" class="text-purple-300" stroke="currentColor" stroke-width="1.5">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                
                <!-- Progress overlay -->
                <div class="absolute inset-0 flex items-center justify-center bg-black/30 rounded-2xl">
                  <svg class="w-24 h-24" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255, 255, 255, 0.2)" stroke-width="4" />
                    <circle
                      class="upload-progress-circle"
                      cx="50" cy="50" r="45"
                      fill="none" stroke="url(#gradient-${msg.id})"
                      stroke-width="4" stroke-linecap="round"
                      stroke-dasharray="${2 * Math.PI * 45}"
                      stroke-dashoffset="${2 * Math.PI * 45}"
                      transform="rotate(-90 50 50)"
                      style="transition: stroke-dashoffset 0.3s ease;"
                    />
                    <defs>
                      <linearGradient id="gradient-${msg.id}" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
                        <stop offset="100%" style="stop-color:#06b6d4;stop-opacity:1" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            ` : `
              <!-- File placeholder with progress on right side -->
              <div class="mt-3">
                <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-800/30 px-3 py-2.5">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" class="text-slate-400" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <path d="M14 2v6h6"></path>
                      </svg>
                    </div>
                    <div class="min-w-0">
                      <div class="text-slate-200 text-sm truncate">${this.escapeHtml(msg.fileName || 'File')}</div>
                      <div class="text-xs text-slate-500">${this.formatFileSize(msg.fileSize || 0)}</div>
                    </div>
                  </div>
                  <!-- Circular progress spinner on right -->
                  <div class="flex-shrink-0 w-10 h-10 flex items-center justify-center upload-progress-container" data-temp-id="${msg.id}">
                    <svg class="w-8 h-8" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255, 255, 255, 0.15)" stroke-width="6" />
                      <circle
                        class="upload-progress-circle"
                        cx="50" cy="50" r="40"
                        fill="none" stroke="url(#gradient-file-${msg.id})"
                        stroke-width="6" stroke-linecap="round"
                        stroke-dasharray="${2 * Math.PI * 40}"
                        stroke-dashoffset="${2 * Math.PI * 40}"
                        transform="rotate(-90 50 50)"
                        style="transition: stroke-dashoffset 0.3s ease;"
                      />
                      <defs>
                        <linearGradient id="gradient-file-${msg.id}" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
                          <stop offset="100%" style="stop-color:#06b6d4;stop-opacity:1" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                </div>
              </div>
            `}
          </div>
        </div>
        <img src="${defaultAvatar}" class="h-10 w-10 rounded-full object-cover ring-1 ring-white/10" alt="me">
      </div>
    </div>`;
  },

  // ========== END MESSAGE RENDERING HELPERS ==========

  /**
   * Append a single new message to the chat without re-rendering everything
   * @param {Object} message - The message object to append
   */
  appendMessage(message) {
    const messagesContainer = document.querySelector('.messages > div');
    if (!messagesContainer) {
      console.warn('[appendMessage] Messages container not found, skipping append');
      return;
    }

    // Check if we need to add a date separator
    const messageDay = this.formatMessageDay(message.createdAt);
    const allDateSeparators = messagesContainer.querySelectorAll('.date-separator');
    const lastDateSeparator = allDateSeparators.length > 0 ? allDateSeparators[allDateSeparators.length - 1] : null;
    const lastDateText = lastDateSeparator ? lastDateSeparator.querySelector('span')?.textContent.trim() : null;

    console.log('[appendMessage] Message day:', messageDay, 'Last date:', lastDateText);

    // Only add date separator if the day is different from the last one
    if (lastDateText !== messageDay) {
      const dateSeparatorHTML = this.messageDateHTML({ type: 'date', text: messageDay });
      messagesContainer.insertAdjacentHTML('beforeend', dateSeparatorHTML);
      console.log('[appendMessage] Added new date separator:', messageDay);
    } else {
      console.log('[appendMessage] Date separator already exists, skipping');
    }

    // Format the message with time
    const messageWithTime = {
      ...message,
      time: this.formatTime(message.createdAt)
    };

    // Generate HTML for the message
    let messageHTML = '';
    switch (messageWithTime.type) {
      case 'incoming':
        messageHTML = this.incomingMessageHTML(messageWithTime);
        break;
      case 'outgoing':
        messageHTML = this.outgoingMessageHTML(messageWithTime);
        break;
      case 'uploading':
        messageHTML = this.uploadingMessageHTML(messageWithTime);
        break;
      default:
        console.warn('[appendMessage] Unknown message type:', messageWithTime.type);
        return;
    }

    // Append the message
    messagesContainer.insertAdjacentHTML('beforeend', messageHTML);

    // Smooth scroll to the new message
    const messagesScrollContainer = document.querySelector('.messages');
    if (messagesScrollContainer) {
      messagesScrollContainer.scrollTo({
        top: messagesScrollContainer.scrollHeight,
        behavior: 'smooth'
      });
    }
  },

  // Render chat content
  renderChat(messages, chatName) {
    // Check if messages array is empty
    if (!messages || messages.length === 0) {
      document.getElementById('mainContent').innerHTML = `
        <section class="flex flex-col h-full overflow-hidden">
          <!-- Empty State -->
          <div class="flex-1 flex items-center justify-center px-6">
            <div class="text-center max-w-md">
              <div class="text-slate-500 mb-2">
                <svg class="mx-auto h-16 w-16 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p class="text-slate-400 text-sm">No messages yet</p>
              <p class="text-slate-500 text-xs mt-1">Start the conversation by sending a message below</p>
            </div>
          </div>

          <!-- Message Input (fixed at bottom of chat area, centered inside chat column) -->
          <div class="mt-auto px-3 md:px-6 pb-3 flex-shrink-0">
            <div class="w-1/2 mx-auto">
              <div class="flex items-end gap-2">
                <textarea 
                  id="messageInput"
                  rows="1"
                  placeholder="Type a message..."
                  class="flex-1 rounded-lg bg-slate-800/50 border border-white/10 focus:border-slate-400/30 focus:outline-none focus:ring-2 focus:ring-white/10 px-4 py-3 text-slate-200 text-sm resize-none max-h-32 overflow-y-auto placeholder:text-slate-500"
                  style="min-height: 44px;"
                ></textarea>
                <button 
                  id="attachButton"
                  type="button"
                  class="flex-shrink-0 h-11 w-11 flex items-center justify-center rounded-lg border border-white/10 bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                  </svg>
                </button>
                <button 
                  id="sendButton"
                  type="button"
                  class="flex-shrink-0 h-11 px-4 flex items-center justify-center rounded-lg border border-white/10 bg-blue-600 hover:bg-blue-700 text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </section>
      `;

      // Re-initialize composer for empty state
      this.initializeComposer();
      return;
    }

    // Sort messages by createdAt timestamp (ascending order)
    const sortedMessages = [...messages].sort((a, b) => {
      const timeA = typeof a.createdAt === 'number' ? a.createdAt : new Date(a.createdAt || 0).getTime();
      const timeB = typeof b.createdAt === 'number' ? b.createdAt : new Date(b.createdAt || 0).getTime();
      return timeA - timeB;
    });

    // Group messages by day and insert date separators
    let currentDay = null;
    const messagesWithSeparators = [];

    sortedMessages.forEach(msg => {
      // Get the day for this message
      const messageDay = this.formatMessageDay(msg.createdAt);

      // If day changed, insert date separator
      if (messageDay !== currentDay) {
        currentDay = messageDay;
        messagesWithSeparators.push({
          type: 'date',
          text: messageDay
        });
      }

      // Add the message with formatted time
      messagesWithSeparators.push({
        ...msg,
        time: this.formatTime(msg.createdAt)
      });
    });

    // Map messages to HTML using helper functions
    const messagesHtml = messagesWithSeparators.map(msg => {
      switch (msg.type) {
        case 'date':
          return this.messageDateHTML(msg);
        case 'time':
          return this.messageTimeHTML(msg);
        case 'incoming':
          return this.incomingMessageHTML(msg);
        case 'outgoing':
          return this.outgoingMessageHTML(msg);
        case 'uploading':
          return this.uploadingMessageHTML(msg);
        default:
          return '';
      }
    }).join('');

    document.getElementById('mainContent').innerHTML = `
      <section class="flex flex-col h-full overflow-hidden">
        <!-- Messages -->
        <div class="flex-1 overflow-y-auto px-3 md:px-6 py-4 messages" style="padding-bottom: 120px;">
          <div class="w-1/2 mx-auto">
            ${messagesHtml}
          </div>
        </div>

        <!-- Message Input (fixed at bottom of chat area, centered inside chat column) -->
        <div class="mt-auto px-3 md:px-6 pb-3 flex-shrink-0">
          <div class="w-1/2 mx-auto sticky bottom-0">
            
            <!-- Upload Preview - Compact 175px Square -->
            <div id="uploadPreview" class="mb-2 hidden">
              <div class="flex items-end gap-3 justify-start">
                <div class="w-[175px] rounded-2xl border border-white/10 bg-slate-700/20 backdrop-blur-md pt-2 px-2 pb-2">
                  <!-- Header: File Size (left) + Cancel Button (right) -->
                  <div class="flex items-center justify-between mb-2">
                    <span id="uploadPreviewSize" class="text-[10px] text-slate-400"></span>
                    <button 
                      type="button" 
                      onclick="SinkApp.cancelFileUpload()"
                      class="p-0.5 rounded hover:bg-white/10 transition-colors text-slate-400 hover:text-red-400"
                      aria-label="Cancel upload"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                  
                  <!-- Image/File Preview -->
                  <div class="relative -mx-2 -mb-2">
                    <div id="uploadPreviewThumbnail" class="w-full h-[175px] rounded-xl overflow-hidden bg-slate-800/50">
                      <!-- Will contain image or icon -->
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Message Composer -->
            <div class="bg-gray-1100 border border-white/10 rounded-full px-3 py-1.5 shadow-lg relative z-50" role="toolbar" aria-label="Message composition">
              <div class="flex items-center gap-2">
                <!-- Upload Attachment Button -->
                <button 
                  type="button"
                  onclick="SinkApp.handleFileAttachment()"
                  aria-label="Upload files"
                  class="flex-shrink-0 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-slate-300" style="stroke-width:1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21.44 11.05 12 20.5a6 6 0 1 1-8.49-8.49L12.5 3.5a4 4 0 1 1 5.66 5.66L8.5 18.5"></path>
                  </svg>
                </button>

                <!-- Message Input -->
                <label for="floatingComposer" class="sr-only">Message ${this.escapeHtml(chatName)}</label>
                <input 
                  type="text" 
                  id="floatingComposer" 
                  aria-label="Type your message to ${this.escapeHtml(chatName)}"
                  placeholder="Message ${this.escapeHtml(chatName)}" 
                  class="flex-1 bg-transparent text-slate-200 placeholder:text-slate-400 text-sm focus:outline-none min-w-0 py-2" 
                  style="font-weight: 400;"
                >

                <!-- Send Button -->
                <button 
                  type="button"
                  aria-label="Send message"
                  class="flex-shrink-0 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                  title="Send"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-white" style="stroke-width:2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 12h14"/>
                    <path d="m12 5 7 7-7 7"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;

    // Scroll to bottom
    setTimeout(() => {
      const messagesContainer = document.querySelector('.messages');
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }, 100);

    // Re-initialize composer for this new textarea
    this.initializeComposer();
  },

  // ========== COMPOSER SUBSYSTEM ==========

  /**
   * Get the current view ID (room or chat)
   * @returns {string|null} The current view ID or null if on welcome screen
   */
  getCurrentViewId() {
    return this.currentView;
  },

  /**
   * Format current time as 'H:MM AM/PM'
   * @returns {string} Formatted time string
   */
  formattedTime() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';

    hours = hours % 12;
    hours = hours ? hours : 12; // Handle midnight (0 hours)
    const minutesStr = minutes < 10 ? '0' + minutes : minutes;

    return `${hours}:${minutesStr} ${ampm}`;
  },

  /**
   * Send a message from the composer to Firebase RTDB
   * NEW: WhatsApp-style single-placeholder flow with tempId synchronization
   * 
   * Flow:
   * 1. Generate tempId
   * 2. Show local placeholder immediately
   * 3. Send to Firebase using same tempId as document key
   * 4. Listener will merge when message arrives (no duplicate)
   */
  async sendMessageFromComposer() {
    // CRITICAL: Prevent multiple simultaneous sends
    if (this.isSending) {
      console.warn('[sendMessage] Already sending, ignoring duplicate call');
      return;
    }
    this.isSending = true;

    try {
      // Get the composer input
      const input = document.getElementById('floatingComposer');
      if (!input) {
        console.error('[sendMessage] Composer input not found');
        this.isSending = false;
        return;
      }

      // Get and validate text
      const text = input.value.trim();

      // Check if we have a pending attachment or text
      const hasPendingAttachment = this.pendingAttachment !== null && this.pendingAttachment !== undefined;
      const hasText = text.length > 0;

      if (!hasPendingAttachment && !hasText) {
        this.isSending = false;
        return; // Don't send empty messages
      }

      // Clear input IMMEDIATELY to provide instant feedback
      const messageText = text;
      input.value = '';
      input.focus();

      // Get current user
      const currentUser = window.auth?.currentUser;
      if (!currentUser) {
        this.showErrorToast('You must be logged in to send messages');
        return;
      }

      // Determine thread type and ID from current view
      const currentViewId = this.getCurrentViewId();
      if (!currentViewId) {
        console.warn('[sendMessage] No active view');
        return;
      }

      // Check if it's a room or DM
      const isRoom = this.data.rooms.find(r => r.id === currentViewId);
      const threadType = isRoom ? 'room' : 'dm';
      const threadId = currentViewId;

      console.log(`[sendMessage] Sending to ${threadType}:${threadId}`);

      // If attachment pending, handle file upload flow
      if (hasPendingAttachment) {
        // Clear attachment IMMEDIATELY to prevent duplicate sends
        const attachmentToSend = this.pendingAttachment;
        this.pendingAttachment = null;
        this.hideUploadPreview();
        await this.uploadAndSendAttachment(threadType, threadId, messageText, currentUser, attachmentToSend);
        this.isSending = false;
        return;
      }

      // ===================================================================
      // TEXT-ONLY MESSAGE FLOW (New Single-Placeholder Pattern)
      // ===================================================================

      // 1. Generate unique tempId
      const tempId = this.genTempId();
      console.log(`[sendMessage] Generated tempId: ${tempId}`);

      // 2. Get current user profile from cache (with avatar)
      const currentUserProfile = await this.getUserProfile(currentUser.uid);

      // 3. Create optimistic placeholder message with real avatar
      const placeholder = {
        id: tempId,
        tempId: tempId,
        type: 'outgoing',
        status: 'sending',
        text: messageText,
        senderId: currentUser.uid,
        senderName: currentUserProfile?.displayName || currentUserProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
        senderAvatar: currentUserProfile?.avatar || currentUserProfile?.photoURL || currentUserProfile?.profilePicture || null,
        createdAt: Date.now()
      };

      // 3. Store in pendingMessages for tracking
      this.pendingMessages[tempId] = placeholder;

      // 4. Render placeholder immediately (optimistic UI)
      this.appendMessage(placeholder);
      this.scrollToBottom();

      // 5. Send to Firebase using saveMessage (with custom tempId)
      if (!window.firebaseService || !window.firebaseService.saveMessage) {
        throw new Error('Firebase service not available');
      }

      const messageToSave = {
        id: tempId,  // CRITICAL: Use tempId as document key
        tempId: tempId,
        type: 'text',
        text: messageText,
        senderId: currentUser.uid,
        senderName: currentUserProfile?.displayName || currentUserProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
        senderAvatar: currentUserProfile?.avatar || currentUserProfile?.photoURL || currentUserProfile?.profilePicture || null,
        createdAt: Date.now(),
        status: 'sent'
      };

      await window.firebaseService.saveMessage(threadType, threadId, messageToSave);

      // 6. Update local placeholder status to 'sent'
      const tempBubble = document.querySelector(`[data-message-id="${tempId}"]`);
      if (tempBubble) {
        tempBubble.setAttribute('data-status', 'sent');
        if (this.pendingMessages[tempId]) {
          this.pendingMessages[tempId].status = 'sent';
        }
      }

      console.log(`[sendMessage] ✅ Message sent with tempId: ${tempId}`);

    } catch (error) {
      console.error('[sendMessage] ❌ Error:', error);
      this.showErrorToast('Failed to send message. Please check your connection and try again.');
    } finally {
      this.isSending = false;
    }
  },

  /**
   * Upload file and send as message with progress shown in message bubble
   * NEW: WhatsApp-style single-placeholder flow with tempId synchronization
   * 
   * Flow:
   * 1. Generate tempId
   * 2. Create placeholder with localPreviewUrl (blob URL) for instant preview
   * 3. Render placeholder immediately with progress indicator
   * 4. Upload file in background using uploadService.uploadFile()
   * 5. Save to Firebase using same tempId as document key
   * 6. Listener will merge when message arrives (no duplicate)
   */
  async uploadAndSendAttachment(threadType, threadId, caption, currentUser, attachment = null) {
    // CRITICAL: Prevent duplicate uploads
    if (this.isUploading) {
      console.warn('[uploadAttachment] Upload already in progress, ignoring duplicate call');
      return;
    }
    this.isUploading = true;

    // Use passed attachment or fallback to pending (for retry)
    const attachmentToUse = attachment || this.pendingAttachment;
    if (!attachmentToUse || !attachmentToUse.file) {
      this.isUploading = false;
      throw new Error('No file to upload');
    }

    // 1. Generate unique temporary ID
    const tempId = this.genTempId();
    console.log(`[uploadAttachment] Generated tempId: ${tempId}`);

    // 2. Get current user profile from cache (with avatar)
    const currentUserProfile = await this.getUserProfile(currentUser.uid);

    // 3. Create local preview URL (blob URL for instant display)
    const localPreviewUrl = URL.createObjectURL(attachmentToUse.file);

    // Get base64 preview for images (for fallback/compatibility)
    let previewDataUrl = null;
    if (attachmentToUse.type && attachmentToUse.type.startsWith('image/')) {
      previewDataUrl = await this.getImageDataURL(attachmentToUse.file);
    }

    // Hide upload preview panel
    this.hideUploadPreview();

    // 4. Create placeholder message with real avatar
    const placeholder = {
      id: tempId,
      tempId: tempId,
      type: 'uploading',
      status: 'uploading',
      progress: 0,
      senderId: currentUser.uid,
      senderName: currentUserProfile?.displayName || currentUserProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
      senderAvatar: currentUserProfile?.avatar || currentUserProfile?.photoURL || currentUserProfile?.profilePicture || null,
      createdAt: Date.now(),
      fileName: attachmentToUse.file.name,
      fileType: attachmentToUse.file.type,
      fileSize: attachmentToUse.file.size,
      localPreviewUrl: localPreviewUrl,  // Blob URL for instant preview
      previewDataUrl: previewDataUrl,    // Base64 for compatibility
      text: caption || ''
    };

    // Store in pendingMessages for tracking
    this.pendingMessages[tempId] = placeholder;

    // 4. Render placeholder immediately (optimistic UI)
    this.appendMessage(placeholder);
    this.scrollToBottom();

    try {
      // 5. Upload file with progress using NEW uploadService
      // NOTE: Import uploadService in home.html first!
      if (!window.uploadService || !window.uploadService.uploadFile) {
        throw new Error('uploadService not available. Make sure to import uploadService.js');
      }

      const uploadResult = await window.uploadService.uploadFile(
        attachmentToUse.file,
        (progress) => {
          // Update progress in placeholder
          if (this.pendingMessages[tempId]) {
            this.pendingMessages[tempId].progress = progress;
          }
          this.updateMessageProgress(tempId, progress);
        }
      );

      console.log(`[uploadAttachment] ✅ Upload complete:`, uploadResult.url);

      // Revoke blob URL to free memory
      URL.revokeObjectURL(localPreviewUrl);

      // 6. Build final message object
      const messageType = attachmentToUse.file.type.startsWith('image/') ? 'image' :
        attachmentToUse.file.type.startsWith('video/') ? 'video' : 'file';

      const finalMessage = {
        id: tempId,  // CRITICAL: Use same tempId as document key
        tempId: tempId,
        type: messageType,
        senderId: currentUser.uid,
        senderName: currentUserProfile?.displayName || currentUserProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'User',
        senderAvatar: currentUserProfile?.avatar || currentUserProfile?.photoURL || currentUserProfile?.profilePicture || null,
        createdAt: Date.now(),
        status: 'sent'
      };

      // Add type-specific fields
      if (messageType === 'image') {
        finalMessage.image = uploadResult.url;
      } else if (messageType === 'video') {
        finalMessage.video = uploadResult.url;
      } else {
        finalMessage.file = {
          url: uploadResult.url,
          name: attachmentToUse.file.name,
          size: uploadResult.size,
          mimeType: uploadResult.mimeType,
          public_id: uploadResult.public_id
        };
      }

      if (caption) {
        finalMessage.text = caption;
      }

      // 7. Save to Firebase using saveMessage (with custom tempId)
      if (!window.firebaseService || !window.firebaseService.saveMessage) {
        throw new Error('firebaseService.saveMessage not available');
      }

      await window.firebaseService.saveMessage(threadType, threadId, finalMessage);
      console.log(`[uploadAttachment] ✅ Message saved to Firebase with tempId: ${tempId}`);

      // 8. Update placeholder status to 'sent'
      this.updateMessageStatus(tempId, 'sent', uploadResult.url);

      // Clear pending attachment
      this.pendingAttachment = null;

      console.log(`[uploadAttachment] ✅ Complete flow finished for tempId: ${tempId}`);

    } catch (error) {
      console.error(`[uploadAttachment] ❌ Error:`, error);

      // Revoke blob URL
      URL.revokeObjectURL(localPreviewUrl);

      // Update placeholder to show error
      this.updateMessageStatus(tempId, 'failed');

      // Store for retry
      if (!this.failedUploads) {
        this.failedUploads = new Map();
      }
      this.failedUploads.set(tempId, {
        threadType,
        threadId,
        caption,
        currentUser,
        file: attachmentToUse.file
      });

      this.pendingAttachment = null;
      this.showErrorToast(`Upload failed: ${error.message}`);
    } finally {
      // CRITICAL: Always reset uploading flag to allow future uploads
      this.isUploading = false;
      console.log('[uploadAttachment] Reset isUploading flag');
    }
  },

  /**
   * Get data URL from image file for preview
   */
  getImageDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  /**
   * Update message progress in placeholder bubble
   * @param {string} tempId - Temporary message ID
   * @param {number} progress - Progress percentage (0-100)
   */
  updateMessageProgress(tempId, progress) {
    const bubble = document.querySelector(`[data-message-id="${tempId}"]`);
    if (!bubble) return;

    // Update progress circle if it exists
    const circle = bubble.querySelector('.upload-progress-circle');
    if (circle) {
      // Get radius from the circle element (supports different sizes)
      const radius = parseFloat(circle.getAttribute('r')) || 45;
      const circumference = 2 * Math.PI * radius;
      const offset = circumference - (progress / 100) * circumference;
      circle.style.strokeDashoffset = offset;
    }

    // Update progress text if it exists
    const progressText = bubble.querySelector('.progress-text');
    if (progressText) {
      progressText.textContent = `${Math.round(progress)}%`;
    }

    console.log(`[updateProgress] ${tempId}: ${progress}%`);
  },

  /**
   * Update message status in placeholder bubble
   * @param {string} tempId - Temporary message ID
   * @param {string} status - New status ('sending'|'uploading'|'sent'|'delivered'|'failed')
   * @param {string} uploadedUrl - Optional: Uploaded file URL (for replacing preview)
   */
  updateMessageStatus(tempId, status, uploadedUrl = null) {
    const bubble = document.querySelector(`[data-message-id="${tempId}"]`);
    if (!bubble) {
      console.warn(`[updateStatus] Bubble not found for tempId: ${tempId}`);
      return;
    }

    bubble.setAttribute('data-status', status);

    if (status === 'sent' || status === 'delivered') {
      // Remove progress overlay for images/videos
      const progressOverlay = bubble.querySelector('.absolute.inset-0');
      if (progressOverlay) {
        progressOverlay.remove();
      }

      // Replace file upload spinner with download button
      const fileProgressContainer = bubble.querySelector('.upload-progress-container');
      if (fileProgressContainer && uploadedUrl) {
        fileProgressContainer.outerHTML = `
          <button onclick="SinkApp.downloadMedia('${uploadedUrl}')" class="flex-shrink-0 inline-flex items-center justify-center rounded-lg bg-slate-900/70 backdrop-blur-md p-2.5 text-white hover:bg-slate-900/80 transition cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7,10 12,15 17,10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
        `;
      }

      // If uploadedUrl provided, replace preview with real URL for images
      if (uploadedUrl) {
        const img = bubble.querySelector('img[alt="Uploading"]');
        if (img) {
          img.src = uploadedUrl;
          img.alt = 'Uploaded';
        }
      }

      console.log(`[updateStatus] ${tempId}: ${status}`);

    } else if (status === 'failed') {
      // Remove progress overlay
      const progressOverlay = bubble.querySelector('.absolute.inset-0');
      if (progressOverlay) {
        progressOverlay.remove();
      }

      // Add error indicator with retry button
      const existingError = bubble.querySelector('.upload-error');
      if (!existingError) {
        const errorHTML = `
          <div class="upload-error mt-2 flex items-center gap-2 text-red-500 text-sm">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
            </svg>
            <span>Upload failed</span>
            <button 
              class="ml-auto px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition"
              onclick="SinkApp.retryUpload('${tempId}')"
            >
              Retry
            </button>
          </div>
        `;

        const messageContent = bubble.querySelector('.max-w-\\[75\\%\\]') || bubble;
        messageContent.insertAdjacentHTML('beforeend', errorHTML);
      }

      console.warn(`[updateStatus] ${tempId}: failed`);
    }
  },

  /**
   * Update upload progress in message bubble (circular progress)
   * @deprecated Use updateMessageProgress instead
   */
  updateUploadProgressInBubble(messageId, progress) {
    this.updateMessageProgress(messageId, progress);
  },

  /**
   * Retry failed upload
   * Restores the failed upload data and re-attempts the upload flow
   */
  async retryUpload(tempId) {
    console.log('[retryUpload] Retrying upload for tempId:', tempId);

    if (!this.failedUploads || !this.failedUploads.has(tempId)) {
      console.error('[retryUpload] No failed upload data found for tempId:', tempId);
      return;
    }

    const uploadData = this.failedUploads.get(tempId);
    this.failedUploads.delete(tempId);

    // Remove error message from bubble
    const tempBubble = document.querySelector(`[data-message-id="${tempId}"]`);
    if (tempBubble) {
      const errorDiv = tempBubble.querySelector('.upload-error');
      if (errorDiv) {
        errorDiv.remove();
      }

      // Reset status to uploading
      this.updateMessageStatus(tempId, 'uploading');

      // Re-add progress overlay
      const messageContent = tempBubble.querySelector('.relative');
      if (messageContent && !messageContent.querySelector('.absolute.inset-0')) {
        const progressHTML = `
          <div class="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center rounded-lg">
            <svg class="w-24 h-24 transform -rotate-90">
              <defs>
                <linearGradient id="progressGradient-${tempId}" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:1" />
                </linearGradient>
              </defs>
              <circle cx="48" cy="48" r="45" stroke="#e5e7eb" stroke-width="6" fill="none"/>
              <circle class="upload-progress-circle" cx="48" cy="48" r="45" stroke="url(#progressGradient-${tempId})" 
                      stroke-width="6" fill="none" stroke-linecap="round"
                      style="stroke-dasharray: ${2 * Math.PI * 45}; stroke-dashoffset: ${2 * Math.PI * 45};"/>
            </svg>
          </div>
        `;
        messageContent.insertAdjacentHTML('beforeend', progressHTML);
      }
    }

    // Set attachment back and retry upload
    this.pendingAttachment = {
      file: uploadData.file
    };

    await this.uploadAndSendAttachment(
      uploadData.threadType,
      uploadData.threadId,
      uploadData.caption,
      uploadData.currentUser
    );
  },

  /**
   * Handle file attachment from composer
   */
  async handleFileAttachment() {
    try {
      // Prevent multiple simultaneous uploads
      if (this.isUploading) {
        console.warn('[handleFileAttachment] Upload already in progress');
        return;
      }

      // Get current user
      const currentUser = window.auth?.currentUser;
      if (!currentUser) {
        this.showErrorToast('You must be logged in to send attachments');
        return;
      }

      // Create file input if it doesn't exist
      let fileInput = document.getElementById('attachmentInput');
      if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'attachmentInput';
        fileInput.accept = '*/*'; // Accept all file types
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        // Add change listener
        fileInput.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;

          console.log('[handleFileAttachment] File selected:', file.name, file.type, `${(file.size / 1024 / 1024).toFixed(2)} MB`);

          // Just store the file, don't upload yet
          this.pendingAttachment = {
            file: file,  // Store the actual File object
            name: file.name,
            size: file.size,
            type: file.type
          };

          // Show preview (no upload)
          await this.showUploadPreview(file);

          // Clear file input for next use
          fileInput.value = '';

          console.log('[handleFileAttachment] ✅ File ready to send. Press Enter to upload and send.');
        });
      }

      // Trigger file picker
      fileInput.click();

    } catch (error) {
      console.error('[handleFileAttachment] ❌ Error:', error);
      this.showErrorToast('Failed to open file picker. Please try again.');
      this.isUploading = false;
    }
  },

  /**
   * Show upload preview with file info and thumbnail
   * @param {File} file - The file to preview
   */
  async showUploadPreview(file) {
    const preview = document.getElementById('uploadPreview');
    const thumbnail = document.getElementById('uploadPreviewThumbnail');
    const sizeEl = document.getElementById('uploadPreviewSize');

    if (!preview || !thumbnail || !sizeEl) return;

    // Set file size
    sizeEl.textContent = this.formatFileSize(file.size);

    // Don't show progress bar - file not uploaded yet

    // Generate thumbnail or icon
    if (file.type.startsWith('image/')) {
      // Show image thumbnail
      const reader = new FileReader();
      reader.onload = (e) => {
        thumbnail.innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover" alt="Preview">`;
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith('video/')) {
      // Show video icon
      thumbnail.innerHTML = `
        <div class="w-full h-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" class="text-purple-300" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </div>
      `;
    } else {
      // Show generic file icon
      thumbnail.innerHTML = `
        <div class="w-full h-full bg-gradient-to-br from-slate-700/50 to-slate-800/50 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" class="text-slate-300" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <path d="M14 2v6h6"></path>
          </svg>
        </div>
      `;
    }

    // Show preview
    preview.classList.remove('hidden');

    // Scroll messages up to accommodate the preview height
    // Wait a bit for the preview to render, then scroll
    setTimeout(() => {
      this.scrollToBottom();
    }, 100);
  },

  /**
   * Update upload progress with simple progress indicator
   * @param {number} percent - Progress percentage (0-100)
   */
  updateUploadProgress(percent) {
    const progressBar = document.getElementById('uploadProgressBar');
    const progressContainer = document.getElementById('uploadProgressContainer');

    if (progressBar) {
      progressBar.style.width = `${percent}%`;
    }

    // Hide progress bar when complete
    if (progressContainer && percent >= 100) {
      setTimeout(() => {
        progressContainer.style.opacity = '0';
        progressContainer.style.transition = 'opacity 0.3s ease-out';
        setTimeout(() => {
          progressContainer.style.display = 'none';
        }, 300);
      }, 500);
    } else if (progressContainer) {
      progressContainer.style.display = 'block';
      progressContainer.style.opacity = '1';
    }
  },

  /**
   * Hide upload preview
   */
  hideUploadPreview() {
    const preview = document.getElementById('uploadPreview');
    if (preview) {
      preview.classList.add('hidden');

      // Scroll messages back down after hiding preview
      setTimeout(() => {
        this.scrollToBottom();
      }, 100);
    }

    // Reset progress bar
    const progressContainer = document.getElementById('uploadProgressContainer');
    if (progressContainer) {
      progressContainer.style.display = 'block';
      progressContainer.style.opacity = '1';
    }

    const progressBar = document.getElementById('uploadProgressBar');
    if (progressBar) {
      progressBar.style.width = '0%';
    }
  },

  /**
   * Cancel file upload
   */
  async cancelFileUpload() {
    // Note: Files uploaded to Cloudinary cannot be deleted with unsigned uploads
    // They will be automatically cleaned up by Cloudinary's auto-deletion policies
    if (this.pendingAttachment && this.pendingAttachment.url) {
      console.log('[cancelFileUpload] ⚠️ File remains on Cloudinary (cannot delete with unsigned uploads):', this.pendingAttachment.url);
    }

    // Clear the file input
    const fileInput = document.getElementById('attachmentInput');
    if (fileInput) {
      fileInput.value = '';
    }

    // Reset upload state
    this.isUploading = false;

    // Clear pending attachment
    this.pendingAttachment = null;

    // Hide preview
    this.hideUploadPreview();

    console.log('[cancelFileUpload] Upload cancelled by user');
  },

  /**
   * Show uploading state in composer (legacy - kept for compatibility)
   * @param {string} fileName - Name of the file being uploaded
   */
  showUploadingState(fileName) {
    // Now handled by showUploadPreview
    console.log('[showUploadingState] Using new preview UI for:', fileName);
  },

  /**
   * Hide uploading state in composer (legacy - kept for compatibility)
   */
  hideUploadingState() {
    // Now handled by hideUploadPreview
    console.log('[hideUploadingState] Using new preview UI');
  },

  /**
   * Show error toast notification
   * @param {string} message - Error message to display
   */
  showErrorToast(message) {
    // Check if toast already exists, remove it first
    const existingToast = document.getElementById('errorToast');
    if (existingToast) {
      existingToast.remove();
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.id = 'errorToast';
    toast.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-6 py-3 bg-rose-600 text-white rounded-lg shadow-lg text-sm font-medium animate-fade-in';
    toast.textContent = message;

    // Add to body
    document.body.appendChild(toast);

    // Auto remove after 4 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  /**
   * Scroll chat to bottom
   */
  scrollToBottom() {
    setTimeout(() => {
      const messagesContainer = document.querySelector('.messages');
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }, 50);
  },

  // Initialize composer textarea auto-resize
  initializeComposer() {
    setTimeout(() => {
      const input = document.getElementById('floatingComposer');
      if (!input) return;

      // Focus the input when composer is initialized
      input.focus();

      // Clear any existing event listeners by cloning and replacing the input
      const newInput = input.cloneNode(true);
      input.parentNode.replaceChild(newInput, input);

      // Get the send button by aria-label
      const sendButton = newInput.parentElement.querySelector('button[aria-label="Send message"]');

      // Handle Enter key (send message unless Shift is held)
      newInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); // Prevent newline
          SinkApp.sendMessageFromComposer();
        }
        // If Shift+Enter, allow default behavior (newline)
      });

      // Handle Send button click
      if (sendButton) {
        sendButton.addEventListener('click', (e) => {
          e.preventDefault();
          SinkApp.sendMessageFromComposer();
        });
      }
    }, 50);
  },

  // ========== END COMPOSER SUBSYSTEM ==========

  // ========== TEST HELPERS ==========

  /**
   * Test function to simulate sending a message (for testing real-time updates)
   * Usage in console:
   *   SinkApp.testSendMessage('room', 'general', 'Hello from tab 1')
   *   // In another tab:
   *   SinkApp.testSendMessage('room', 'general', 'Hello from tab 2')
   */
  async testSendMessage(threadType, threadId, text) {
    console.log(`[testSendMessage] Sending test message to ${threadType}:${threadId}`);

    if (!window.firebaseService || !window.firebaseService.sendMessage) {
      console.error('[testSendMessage] firebaseService.sendMessage not available');
      return;
    }

    const currentUser = window.auth?.currentUser;
    if (!currentUser) {
      console.error('[testSendMessage] No authenticated user');
      return;
    }

    try {
      const messageData = {
        type: 'text',
        text: text,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || currentUser.email?.split('@')[0] || 'Test User',
        createdAt: Date.now()
      };

      await window.firebaseService.sendMessage(threadType, threadId, messageData);
      console.log('[testSendMessage] ✅ Message sent successfully');
    } catch (error) {
      console.error('[testSendMessage] ❌ Error sending message:', error);
    }
  }

  // ========== END TEST HELPERS ==========
};

// Export SinkApp to window for access from inline scripts
window.SinkApp = SinkApp;

/* ========== ROUTER TESTING GUIDE ==========
 * 
 * Manual Test Steps (run in browser console):
 * 
 * 1. Test route parsing:
 *    SinkApp.getRouteFromHash()
 *    // Should return current route object
 * 
 * 2. Test navigation to room:
 *    SinkApp.navigateTo('room', 'general')
 *    // Should navigate to #room/general and display General room
 * 
 * 3. Test navigation to chat:
 *    SinkApp.navigateTo('chat', 'yash')
 *    // Should navigate to #chat/yash and display Yash chat
 * 
 * 4. Test direct URL (in address bar):
 *    - Type: http://localhost:port/#room/design
 *    - Reload page
 *    // Should load directly into Design room
 * 
 * 5. Test back/forward buttons:
 *    - Navigate: General -> Design -> Yash chat
 *    - Click browser back button
 *    // Should go back to Design room
 *    - Click browser forward button
 *    // Should go forward to Yash chat
 * 
 * 6. Test manual hash change:
 *    window.location.hash = '#chat/dc'
 *    // Should navigate to Dc chat
 * 
 * 7. Test welcome screen:
 *    window.location.hash = ''
 *    // Should show welcome screen
 * 
 * 8. Test invalid route:
 *    window.location.hash = '#invalid/route'
 *    // Should show welcome screen (fallback)
 * 
 * 9. Verify no double calls:
 *    - Add console.log in openRoom/openChat
 *    - Click sidebar link
 *    // Should see only ONE console.log per click
 * 
 * 10. Test current view tracking:
 *     SinkApp.currentView
 *     // Should return the current view id or null for welcome
 * 
 * ========================================== */

/* ========== COMPOSER TESTING GUIDE ==========
 * 
 * Manual Test Steps:
 * 
 * 1. Test getCurrentViewId():
 *    - Navigate to a room: SinkApp.navigateTo('room', 'general')
 *    - Console: SinkApp.getCurrentViewId()
 *    // Should return: 'general'
 * 
 * 2. Test formattedTime():
 *    - Console: SinkApp.formattedTime()
 *    // Should return current time like: '3:21 PM'
 * 
 * 3. Test sending a message (via UI):
 *    - Navigate to General room
 *    - Type "Hello world" in the composer input
 *    - Click the Send button
 *    // Should: 
 *    //   - Add new outgoing message bubble with "Hello world"
 *    //   - Clear the input field
 *    //   - Keep focus on input
 *    //   - Auto-scroll to bottom
 * 
 * 4. Test Enter key to send:
 *    - Type "Test message" in composer
 *    - Press Enter (not Shift+Enter)
 *    // Should send the message and clear input
 * 
 * 5. Test Shift+Enter for newline:
 *    - Type "Line 1"
 *    - Press Shift+Enter
 *    - Type "Line 2"
 *    - Press Enter to send
 *    // Should send multiline message with both lines
 * 
 * 6. Test empty message validation:
 *    - Leave input empty
 *    - Click Send
 *    // Should NOT send (no new message appears)
 * 
 * 7. Test whitespace-only message:
 *    - Type only spaces "    "
 *    - Click Send
 *    // Should NOT send (trimmed to empty)
 * 
 * 8. Test message persistence in data:
 *    - Send a message "Test data persistence"
 *    - Console: SinkApp.data.messages.general
 *    // Should show array including the new message object
 * 
 * 9. Test messages in different views:
 *    - Navigate to General room
 *    - Send message "Message in General"
 *    - Navigate to Design room
 *    - Send message "Message in Design"
 *    - Console: SinkApp.data.messages.general
 *    - Console: SinkApp.data.messages.design
 *    // Each should show messages in correct room
 * 
 * 10. Test chat (DM) messages:
 *     - Navigate to Yash chat: SinkApp.navigateTo('chat', 'yash')
 *     - Send message "Hey Yash!"
 *     - Console: SinkApp.data.messages.yash
 *     // Should show the new outgoing message
 * 
 * 11. Test auto-scroll:
 *     - Navigate to General room (has many messages)
 *     - Scroll to top of chat
 *     - Send a new message
 *     // Should auto-scroll to bottom to show new message
 * 
 * 12. Test input focus retention:
 *     - Send a message
 *     // Input should still be focused (can type immediately)
 * 
 * 13. Test sendMessage() programmatically:
 *     - Console: SinkApp.sendMessage('Programmatic test')
 *     // Should add message to current view
 * 
 * 14. Test with special characters:
 *     - Type message with emojis: "Hello 👋 World 🌍"
 *     - Send
 *     // Should display correctly in message bubble
 * 
 * 15. Test message time format:
 *     - Send multiple messages at different times
 *     // Each should show correct timestamp (e.g., "3:21 PM")
 * 
 * ========================================== */

/* ========== REAL-TIME MESSAGING TEST GUIDE ==========
 * 
 * Prerequisites:
 * - Ensure Firebase RTDB has messages in: messages/rooms/{roomId} and messages/dms/{chatId}
 * - Ensure firebaseService.listenForMessages and sendMessage are working
 * - Have two browser tabs open with the same user logged in
 * 
 * Test 1: Verify listener attachment and message loading
 * ---------------------------------------------------
 * 1. Open browser console
 * 2. Navigate to a room: SinkApp.navigateTo('room', 'general')
 * 3. Check console for:
 *    ✓ "[openRoom] Opening room: general"
 *    ✓ "[openRoom] Attaching listener for room: general"
 *    ✓ "[openRoom] ✉️ New message received: {...}"
 *    ✓ "[openRoom] ✅ Formatted message: {...}"
 *    ✓ "[openRoom] ✅ Listener attached successfully"
 * 4. Verify messages appear in the chat area
 * 5. Check cache: console.log(SinkApp.messagesCache['room:general'])
 *    // Should show array of formatted messages
 * 
 * Test 2: Verify listener detachment when switching threads
 * ----------------------------------------------------------
 * 1. Open General room: SinkApp.navigateTo('room', 'general')
 * 2. Wait for messages to load
 * 3. Switch to another room: SinkApp.navigateTo('room', 'design')
 * 4. Check console for:
 *    ✓ "[openRoom] Detaching previous thread listener"
 *    ✓ "[openRoom] Opening room: design"
 * 5. Verify no duplicate messages appear
 * 6. Check listener count: Should only have ONE active listener
 * 
 * Test 3: Real-time message arrival (cross-tab test)
 * ---------------------------------------------------
 * TAB 1:
 * 1. Open General room
 * 2. Keep console open to watch for new messages
 * 
 * TAB 2:
 * 1. Open General room
 * 2. Send a test message:
 *    await SinkApp.testSendMessage('room', 'general', 'Hello from Tab 2')
 * 
 * VERIFY in TAB 1:
 * ✓ Console shows: "[openRoom] ✉️ New message received: {...}"
 * ✓ New message appears at bottom of chat
 * ✓ Message has correct text: "Hello from Tab 2"
 * ✓ Message type is "incoming" (if from different user) or "outgoing" (same user)
 * 
 * Test 4: Message ordering and chronological sorting
 * ---------------------------------------------------
 * 1. Open any room with messages
 * 2. Check console: SinkApp.messagesCache['room:general']
 * 3. Verify messages are sorted by createdAt timestamp (oldest first)
 * 4. Send multiple messages rapidly:
 *    await SinkApp.testSendMessage('room', 'general', 'Message 1')
 *    await SinkApp.testSendMessage('room', 'general', 'Message 2')
 *    await SinkApp.testSendMessage('room', 'general', 'Message 3')
 * 5. Verify all messages appear in correct order
 * 
 * Test 5: Duplicate message prevention
 * -------------------------------------
 * 1. Open General room
 * 2. Note initial message count: SinkApp.messagesCache['room:general'].length
 * 3. Refresh the page (F5)
 * 4. Navigate back to General room
 * 5. Check message count again
 * 6. Verify: No duplicate messages (count should match original)
 * 7. Console should show: "[openRoom] Message already in cache, skipping"
 * 
 * Test 6: Loading placeholder on first load
 * ------------------------------------------
 * 1. Clear cache: SinkApp.messagesCache = {}
 * 2. Navigate to room: SinkApp.navigateTo('room', 'general')
 * 3. Verify loading spinner appears briefly
 * 4. Wait for messages to load
 * 5. Verify messages replace loading spinner
 * 
 * Test 7: Cached messages on subsequent loads
 * --------------------------------------------
 * 1. Open General room (messages will be cached)
 * 2. Navigate away: SinkApp.navigateTo('room', 'design')
 * 3. Navigate back: SinkApp.navigateTo('room', 'general')
 * 4. Verify: Messages appear IMMEDIATELY (no loading spinner)
 * 5. Console shows: "[openRoom] Rendering X cached messages"
 * 
 * Test 8: DM (Direct Message) threads
 * ------------------------------------
 * 1. Find a DM chat ID from your Firestore (e.g., 'dm_uid1_uid2')
 * 2. Navigate: SinkApp.navigateTo('chat', 'dm_uid1_uid2')
 * 3. Send test message:
 *    await SinkApp.testSendMessage('dm', 'dm_uid1_uid2', 'DM test')
 * 4. Verify message appears in chat
 * 5. Check cache: SinkApp.messagesCache['dm:dm_uid1_uid2']
 * 
 * Test 9: Message read marking (optional feature)
 * ------------------------------------------------
 * 1. Open a room
 * 2. Send a message from another tab/user
 * 3. Check console for: "Marking message as read" (if implemented)
 * 4. Verify firebaseService.markRead is called for incoming messages
 * 
 * Test 10: Stress test - Multiple rapid messages
 * -----------------------------------------------
 * TAB 1: Keep General room open
 * TAB 2: Send 10 messages rapidly:
 *    for(let i=0; i<10; i++) {
 *      await SinkApp.testSendMessage('room', 'general', `Rapid message ${i+1}`)
 *    }
 * 
 * VERIFY in TAB 1:
 * ✓ All 10 messages appear
 * ✓ Messages are in correct order
 * ✓ No duplicates
 * ✓ UI doesn't freeze or lag
 * 
 * Test 11: Verify message format structure
 * -----------------------------------------
 * 1. Open any room
 * 2. Console: SinkApp.messagesCache['room:general'][0]
 * 3. Verify object has required fields:
 *    {
 *      id: string,
 *      type: 'incoming' | 'outgoing',
 *      sender: string,
 *      text: string,
 *      time: '3:21 PM',
 *      createdAt: 1234567890 (number),
 *      avatar: string (URL)
 *    }
 * 
 * Test 12: Error handling - Invalid thread
 * -----------------------------------------
 * 1. Try opening non-existent room:
 *    SinkApp.navigateTo('room', 'nonexistent')
 * 2. Check console for error: "[openRoom] Room not found"
 * 3. Verify app doesn't crash
 * 
 * Quick Debug Commands:
 * ---------------------
 * - Check current view: SinkApp.currentView
 * - Check active listener: SinkApp.currentThreadListener
 * - Check all cached messages: SinkApp.messagesCache
 * - Check specific thread: SinkApp.messagesCache['room:general']
 * - Count messages: Object.keys(SinkApp.messagesCache).length
 * - Clear cache: SinkApp.messagesCache = {}
 * - Test send: await SinkApp.testSendMessage('room', 'general', 'Test')
 * 
 * Expected Console Output Pattern:
 * --------------------------------
 * [openRoom] Opening room: general
 * [openRoom] Detaching previous thread listener (if switching)
 * [openRoom] Showing loading placeholder OR Rendering X cached messages
 * [openRoom] Attaching listener for room: general
 * [openRoom] ✉️ New message received: {id: "...", text: "...", ...}
 * [formatMessage] ...
 * [openRoom] ✅ Formatted message: {id: "...", type: "incoming", ...}
 * [openRoom] Cache now has X messages
 * [openRoom] Re-rendering chat with updated messages
 * [openRoom] ✅ Listener attached successfully
 * 
 * Success Criteria:
 * -----------------
 * ✓ Messages load from RTDB and display in chat
 * ✓ New messages appear in real-time without refresh
 * ✓ Switching rooms detaches old listener properly
 * ✓ No duplicate messages in cache
 * ✓ Messages sorted chronologically by createdAt
 * ✓ Cross-tab messaging works (send in one tab, see in another)
 * ✓ Loading state shows on first load, cached messages on subsequent loads
 * ✓ Console logs are clear and informative for debugging
 * 
 * ========================================== */
