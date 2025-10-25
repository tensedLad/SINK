import { auth, signInWithEmailAndPassword, createUserProfileDocument } from '../services/firebase.js';

/**
 * Validate username according to security requirements
 * @param {string} username - The username to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function validateUsername(username) {
  // Username must be at least 2 characters and contain only lowercase letters, numbers, dots, underscores, hyphens
  const usernameRegex = /^[a-z0-9._-]{2,}$/;
  return usernameRegex.test(username);
}

/**
 * Construct email from username
 * @param {string} username - The username
 * @returns {string} - The constructed email
 */
function constructEmail(username) {
  return `${username.trim().toLowerCase()}@sink.in`;
}

/**
 * Show error message to user
 * @param {string} message - Error message to display
 */
function showError(message) {
  const errorDiv = document.getElementById('loginError');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Shake animation
    errorDiv.classList.add('shake');
    setTimeout(() => {
      errorDiv.classList.remove('shake');
    }, 500);
  }
}

/**
 * Hide error message
 */
function hideError() {
  const errorDiv = document.getElementById('loginError');
  if (errorDiv) {
    errorDiv.style.display = 'none';
  }
}

/**
 * Show loading state
 */
function showLoading() {
  const submitButton = document.querySelector('#loginForm button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML = `
      <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
        <path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="0.75"></path>
      </svg>
    `;
  }
}

/**
 * Hide loading state
 */
function hideLoading() {
  const submitButton = document.querySelector('#loginForm button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.innerHTML = `
      <span class="text-sm flex items-center">SIGN IN</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="opacity-90 group-hover:opacity-100 flex-shrink-0" style="stroke-width:1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
        <polyline points="10,17 15,12 10,7"></polyline>
        <line x1="15" y1="12" x2="3" y2="12"></line>
      </svg>
    `;
  }
}

/**
 * Handle login form submission
 * @param {Event} event - Form submit event
 */
async function handleLogin(event) {
  // CRITICAL: Prevent form submission
  event.preventDefault();
  event.stopPropagation();
  
  console.log('Login form submitted');
  
  // Hide any previous errors
  hideError();
  
  // Get form inputs
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  
  if (!usernameInput || !passwordInput) {
    console.error('Form inputs not found');
    showError('Form inputs not found. Please refresh the page.');
    return false;
  }
  
  const username = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  
  console.log('Username length:', username.length, 'Password length:', password.length);
  
  // Validate inputs - CRITICAL: Check for empty/invalid before proceeding
  if (!username || username.length === 0) {
    console.log('Empty username detected');
    showError('Please enter your username.');
    usernameInput.focus();
    return false;
  }
  
  if (!validateUsername(username)) {
    console.log('Invalid username format:', username);
    showError('Invalid username format. Use only lowercase letters, numbers, dots, underscores, or hyphens (minimum 2 characters).');
    usernameInput.focus();
    return false;
  }
  
  if (!password || password.length === 0) {
    console.log('Empty password detected');
    showError('Please enter your password.');
    passwordInput.focus();
    return false;
  }
  
  if (password.length < 6) {
    console.log('Password too short:', password.length);
    showError('Password must be at least 6 characters.');
    passwordInput.focus();
    return false;
  }
  
  // Construct email
  const email = constructEmail(username);
  console.log('Proceeding with login for email:', email);
  
  // Show loading state
  showLoading();
  
  try {
    // Sign in with Firebase
    console.log('Attempting to sign in with email:', email);
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    console.log('Sign in successful:', user.email);
    
    // Ensure user profile exists in Firestore/RTDB
    try {
      await createUserProfileDocument(user, { username });
      console.log('User profile created/updated');
    } catch (profileError) {
      console.error('Error creating user profile:', profileError);
      // Continue anyway - profile creation is not critical for login
    }
    
    // Redirect to home page
    console.log('Redirecting to home.html...');
    window.location.href = 'home.html';
    
  } catch (error) {
    console.error('Login error:', error);
    hideLoading();
    
    // Handle specific Firebase error codes
    switch (error.code) {
      case 'auth/invalid-email':
        showError('Invalid email format.');
        break;
      case 'auth/user-disabled':
        showError('This account has been disabled. Please contact support.');
        break;
      case 'auth/user-not-found':
        showError('Invalid username or password. Please check your credentials.');
        break;
      case 'auth/wrong-password':
        showError('Invalid username or password. Please check your credentials.');
        break;
      case 'auth/invalid-credential':
        showError('Invalid credentials. Please check your username and password.');
        break;
      case 'auth/missing-password':
        showError('Please enter your password.');
        break;
      case 'auth/too-many-requests':
        showError('Too many failed login attempts. Please try again later.');
        break;
      case 'auth/network-request-failed':
        showError('Network error. Please check your internet connection.');
        break;
      default:
        showError(`Login failed: ${error.message || 'An unexpected error occurred.'}`);
    }
    
    return false;
  }
}

/**
 * Test login function for console testing
 * Usage: window.testLogin('tony', 'password123')
 * @param {string} username - Username to test
 * @param {string} password - Password to test
 */
async function testLogin(username, password) {
  console.log(`Testing login with username: ${username}`);
  
  if (!validateUsername(username)) {
    console.error('Invalid username format');
    return;
  }
  
  const email = constructEmail(username);
  console.log(`Constructed email: ${email}`);
  
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    console.log('✅ Login successful!', userCredential.user);
    
    // Create/update profile
    await createUserProfileDocument(userCredential.user, { username });
    console.log('✅ User profile created/updated');
    
    return userCredential.user;
  } catch (error) {
    console.error('❌ Login failed:', error.code, error.message);
    throw error;
  }
}

/**
 * Sign out function for console testing
 * Usage: window.testSignOut()
 */
async function testSignOut() {
  try {
    await auth.signOut();
    console.log('✅ Sign out successful!');
    console.log('Current user:', auth.currentUser); // Should be null
    
    // Reload page to show login form
    setTimeout(() => {
      window.location.href = 'login.html?logout=true';
    }, 500);
  } catch (error) {
    console.error('❌ Sign out failed:', error);
    throw error;
  }
}

/**
 * Clear all auth state and reload - for testing
 * Usage: window.clearAuthAndReload()
 */
async function clearAuthAndReload() {
  try {
    console.log('Clearing authentication state...');
    await auth.signOut();
    
    // Clear any cached data
    if (window.localStorage) {
      const keys = Object.keys(window.localStorage);
      keys.forEach(key => {
        if (key.includes('firebase') || key.includes('auth')) {
          window.localStorage.removeItem(key);
          console.log('Removed:', key);
        }
      });
    }
    
    console.log('✅ Auth state cleared. Reloading page...');
    window.location.href = 'login.html?logout=true';
  } catch (error) {
    console.error('❌ Clear auth failed:', error);
    throw error;
  }
}

// Initialize login form when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('Login page loaded');
  
  const loginForm = document.getElementById('loginForm');
  
  if (loginForm) {
    // Remove any existing listeners to prevent double submission
    const newForm = loginForm.cloneNode(true);
    loginForm.parentNode.replaceChild(newForm, loginForm);
    
    // Add submit listener
    newForm.addEventListener('submit', handleLogin);
    console.log('Login form initialized');
  } else {
    console.error('Login form not found');
  }
  
  // Check if user came from a logout action
  const urlParams = new URLSearchParams(window.location.search);
  const fromLogout = urlParams.get('logout') === 'true';
  
  if (fromLogout) {
    console.log('User came from logout, staying on login page');
    // Don't auto-redirect if user just logged out
    return;
  }
  
  // Check if user is already logged in (only redirect if truly authenticated)
  console.log('Setting up auth state listener on login page');
  let authCheckComplete = false;
  
  auth.onAuthStateChanged((user) => {
    if (authCheckComplete) return; // Prevent multiple triggers
    authCheckComplete = true;
    
    if (user) {
      console.log('User already logged in:', user.email);
      console.log('Redirecting to home.html...');
      // Add small delay to prevent race condition
      setTimeout(() => {
        window.location.href = 'home.html';
      }, 100);
    } else {
      console.log('No user logged in, staying on login page');
    }
  });
  
  // Expose test functions to window
  window.testLogin = testLogin;
  window.testSignOut = testSignOut;
  window.clearAuthAndReload = clearAuthAndReload;
  
  console.log('Login helpers available:');
  console.log('- window.testLogin(username, password) - Test login from console');
  console.log('- window.testSignOut() - Sign out current user');
  console.log('- window.clearAuthAndReload() - Clear all auth cache and reload');
});
