/**
 * ============================================================
 * Upload Service - Cloudinary Integration with Progress
 * ============================================================
 * 
 * Handles file uploads to Cloudinary with real-time progress tracking.
 * Uses XMLHttpRequest for upload progress events (fetch doesn't support this).
 * 
 * Features:
 * - Image compression before upload
 * - File size validation
 * - Progress tracking (0-100%)
 * - Cancellable uploads via AbortController pattern
 * - Returns upload metadata (url, public_id, size, mimeType)
 */

// ============================================================================
// CLOUDINARY CONFIGURATION
// ============================================================================

const CLOUDINARY_CONFIG = {
  cloudName: 'dpki5sq6i',
  uploadPreset: 'chat_uploads',
  apiUrl: 'https://api.cloudinary.com/v1_1/dpki5sq6i/auto/upload'
};

// File size limits (in MB)
const FILE_SIZE_LIMITS = {
  image: 10,      // 10 MB for images
  video: 100,     // 100 MB for videos
  document: 20,   // 20 MB for PDFs/documents
  other: 25       // 25 MB for other files
};

/**
 * Validate file size based on type
 * @param {File} file - File to validate
 * @throws {Error} If file exceeds size limit
 */
function validateFileSize(file) {
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
             file.type.includes('officedocument')) {
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
  
  console.log(`[uploadService] File size OK: ${fileSizeMB.toFixed(2)} MB / ${sizeLimit} MB limit`);
}

/**
 * Compress image using browser-image-compression
 * @param {File} file - Image file to compress
 * @returns {Promise<File>} - Compressed image file
 */
async function compressImage(file) {
  console.log('[uploadService] Compressing image...');
  
  const options = {
    maxSizeMB: 1,           // Max file size in MB
    maxWidthOrHeight: 1920, // Max dimension
    useWebWorker: true,
    fileType: file.type
  };
  
  try {
    const compressed = await imageCompression(file, options);
    console.log('[uploadService] Image compression complete:', {
      original: (file.size / 1024 / 1024).toFixed(2) + ' MB',
      compressed: (compressed.size / 1024 / 1024).toFixed(2) + ' MB',
      reduction: ((1 - compressed.size / file.size) * 100).toFixed(1) + '%'
    });
    return compressed;
  } catch (error) {
    console.warn('[uploadService] Image compression failed, using original:', error);
    return file;
  }
}

/**
 * Upload file to Cloudinary with progress tracking
 * 
 * @param {File} file - File to upload
 * @param {Function} onProgress - Callback function for progress updates (0-100)
 * @returns {Promise<Object>} Upload result with { url, public_id, size, mimeType, raw }
 * 
 * @example
 * const result = await uploadFile(file, (progress) => {
 *   console.log(`Upload progress: ${progress}%`);
 * });
 * console.log('Uploaded to:', result.url);
 */
export async function uploadFile(file, onProgress = () => {}) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log('[uploadService] Starting upload:', file.name, file.type, file.size);
      
      // Validate file size
      validateFileSize(file);
      
      // Compress image if needed
      let fileToUpload = file;
      if (file.type.startsWith('image/')) {
        onProgress(5);
        fileToUpload = await compressImage(file);
        onProgress(10);
      }
      
      // Create FormData for upload
      const formData = new FormData();
      formData.append('file', fileToUpload);
      formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
      
      // Use XMLHttpRequest for progress tracking
      const xhr = new XMLHttpRequest();
      
      // Track upload progress
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          // Calculate progress: 10% already used for compression, so map 0-100 to 10-100
          const uploadProgress = Math.round((event.loaded / event.total) * 90) + 10;
          onProgress(uploadProgress);
        }
      };
      
      // Handle successful upload
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            console.log('[uploadService] ✅ Upload complete:', response.secure_url);
            
            resolve({
              url: response.secure_url || response.url,
              public_id: response.public_id,
              size: file.size,
              mimeType: file.type,
              raw: response
            });
          } catch (parseError) {
            reject(new Error('Failed to parse upload response'));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.statusText} (${xhr.status})`));
        }
      };
      
      // Handle network errors
      xhr.onerror = () => {
        reject(new Error('Network error during upload'));
      };
      
      // Handle upload abort
      xhr.onabort = () => {
        reject(new Error('Upload cancelled'));
      };
      
      // Start upload
      xhr.open('POST', CLOUDINARY_CONFIG.apiUrl, true);
      xhr.send(formData);
      
      // Store XHR for potential cancellation
      // (caller can access via uploadFile.currentXHR if needed)
      uploadFile.currentXHR = xhr;
      
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Cancel the current upload
 * @returns {boolean} True if upload was cancelled, false if no upload in progress
 */
export function cancelUpload() {
  if (uploadFile.currentXHR) {
    uploadFile.currentXHR.abort();
    uploadFile.currentXHR = null;
    console.log('[uploadService] Upload cancelled');
    return true;
  }
  return false;
}
