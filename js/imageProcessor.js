/**
 * ============================================================================
 * imageProcessor.js — Canvas-Based Image Pre-Processing Pipeline
 * ============================================================================
 * 
 * All operations run on raw ImageData pixel arrays using the Canvas API.
 * No external libraries required — pure JavaScript for maximum speed.
 * 
 * Pipeline for OCR preparation:
 *   1. Grayscale conversion (luminance formula)
 *   2. Gaussian blur (noise reduction)
 *   3. Adaptive thresholding (binarization robust to lighting)
 *   4. Morphological operations (clean up artifacts)
 *   5. Contrast enhancement (maximize digit clarity)
 * 
 * ============================================================================
 */

class ImageProcessor {

    // ========================================================================
    // Grayscale Conversion
    // ========================================================================

    /**
     * Converts an RGBA ImageData to grayscale using the luminance formula.
     * Modifies the pixel data in-place: R=G=B=luminance, A unchanged.
     * Formula: L = 0.299*R + 0.587*G + 0.114*B (ITU-R BT.601)
     * 
     * @param {ImageData} imageData - The image data to convert
     * @returns {ImageData} The same imageData (modified in-place)
     */
    static grayscale(imageData) {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = data[i + 1] = data[i + 2] = lum;
        }
        return imageData;
    }

    // ========================================================================
    // Gaussian Blur — Noise Reduction
    // ========================================================================

    /**
     * Applies a 3×3 Gaussian blur to reduce noise before thresholding.
     * Uses separable convolution for efficiency (two 1D passes).
     * 
     * Kernel: [1, 2, 1] / 4 (normalized 1D Gaussian approximation)
     * 
     * @param {ImageData} imageData - Grayscale image data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Uint8ClampedArray} Blurred grayscale values (single channel)
     */
    static gaussianBlur(imageData, width, height) {
        const src = imageData.data;
        const gray = new Float32Array(width * height);
        const temp = new Float32Array(width * height);
        const result = new Float32Array(width * height);

        // Extract grayscale channel
        for (let i = 0; i < width * height; i++) {
            gray[i] = src[i * 4];
        }

        // Horizontal pass: [1, 2, 1] / 4
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const left  = x > 0 ? gray[idx - 1] : gray[idx];
                const right = x < width - 1 ? gray[idx + 1] : gray[idx];
                temp[idx] = (left + 2 * gray[idx] + right) / 4;
            }
        }

        // Vertical pass: [1, 2, 1] / 4
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const up   = y > 0 ? temp[idx - width] : temp[idx];
                const down = y < height - 1 ? temp[idx + width] : temp[idx];
                result[idx] = (up + 2 * temp[idx] + down) / 4;
            }
        }

        return result;
    }

    // ========================================================================
    // Adaptive Thresholding — Robust Binarization
    // ========================================================================

    /**
     * Applies adaptive mean thresholding. For each pixel, the threshold is
     * computed as the mean intensity in a local block minus a constant C.
     * This handles uneven lighting much better than global thresholding.
     * 
     * Pixel → 255 (white) if value > localMean - C, else → 0 (black)
     * 
     * Uses integral image for O(1) block mean computation.
     * 
     * @param {Float32Array} gray - Single-channel grayscale values
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} blockSize - Size of the local neighborhood (odd number)
     * @param {number} C - Constant subtracted from the mean
     * @returns {Uint8Array} Binary image (0 or 255 per pixel)
     */
    static adaptiveThreshold(gray, width, height, blockSize = 15, C = 10) {
        const binary = new Uint8Array(width * height);
        const halfBlock = Math.floor(blockSize / 2);

        // Build integral image for O(1) rectangular sum queries
        const integral = new Float64Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y++) {
            let rowSum = 0;
            for (let x = 0; x < width; x++) {
                rowSum += gray[y * width + x];
                integral[(y + 1) * (width + 1) + (x + 1)] =
                    rowSum + integral[y * (width + 1) + (x + 1)];
            }
        }

        // For each pixel, compute local mean and threshold
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // Compute block boundaries (clamped to image edges)
                const y1 = Math.max(0, y - halfBlock);
                const y2 = Math.min(height - 1, y + halfBlock);
                const x1 = Math.max(0, x - halfBlock);
                const x2 = Math.min(width - 1, x + halfBlock);

                const count = (y2 - y1 + 1) * (x2 - x1 + 1);

                // Sum via integral image: sum = I(y2+1,x2+1) - I(y1,x2+1) - I(y2+1,x1) + I(y1,x1)
                const sum =
                    integral[(y2 + 1) * (width + 1) + (x2 + 1)] -
                    integral[y1 * (width + 1) + (x2 + 1)] -
                    integral[(y2 + 1) * (width + 1) + x1] +
                    integral[y1 * (width + 1) + x1];

                const mean = sum / count;
                const val = gray[y * width + x];

                // Threshold: white if brighter than local mean - C
                binary[y * width + x] = val > (mean - C) ? 255 : 0;
            }
        }

        return binary;
    }

    // ========================================================================
    // Global Otsu Thresholding — Alternative binarization
    // ========================================================================

    /**
     * Otsu's method: automatically determines the optimal global threshold
     * by minimizing intra-class variance. Better for uniform lighting.
     * 
     * @param {Float32Array} gray - Single-channel grayscale values
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Uint8Array} Binary image (0 or 255 per pixel)
     */
    static otsuThreshold(gray, width, height) {
        const totalPixels = width * height;
        const binary = new Uint8Array(totalPixels);

        // Build histogram (256 bins)
        const histogram = new Float64Array(256);
        for (let i = 0; i < totalPixels; i++) {
            histogram[Math.round(gray[i])]++;
        }

        // Normalize histogram
        for (let i = 0; i < 256; i++) {
            histogram[i] /= totalPixels;
        }

        // Find optimal threshold (maximize inter-class variance)
        let bestThreshold = 0;
        let bestVariance = 0;
        let w0 = 0, mu0 = 0, muTotal = 0;

        for (let t = 0; t < 256; t++) {
            muTotal += t * histogram[t];
        }

        for (let t = 0; t < 256; t++) {
            w0 += histogram[t];
            if (w0 === 0) continue;

            const w1 = 1 - w0;
            if (w1 === 0) break;

            mu0 += t * histogram[t];
            const mu1 = (muTotal - mu0) / w1;
            const mean0 = mu0 / w0;

            const variance = w0 * w1 * (mean0 - mu1) * (mean0 - mu1);
            if (variance > bestVariance) {
                bestVariance = variance;
                bestThreshold = t;
            }
        }

        // Apply threshold
        for (let i = 0; i < totalPixels; i++) {
            binary[i] = gray[i] > bestThreshold ? 255 : 0;
        }

        return binary;
    }

    // ========================================================================
    // Morphological Operations — Clean Up Artifacts
    // ========================================================================

    /**
     * Dilation: expands white regions. Useful for closing gaps in grid lines.
     * Uses a square structuring element.
     * 
     * @param {Uint8Array} binary - Binary image
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} kernelSize - Size of structuring element (odd number)
     * @returns {Uint8Array} Dilated binary image
     */
    static dilate(binary, width, height, kernelSize = 3) {
        const result = new Uint8Array(width * height);
        const half = Math.floor(kernelSize / 2);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let maxVal = 0;
                for (let ky = -half; ky <= half; ky++) {
                    for (let kx = -half; kx <= half; kx++) {
                        const ny = y + ky;
                        const nx = x + kx;
                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            if (binary[ny * width + nx] > maxVal) {
                                maxVal = binary[ny * width + nx];
                            }
                        }
                    }
                }
                result[y * width + x] = maxVal;
            }
        }

        return result;
    }

    /**
     * Erosion: shrinks white regions. Useful for removing noise.
     * Uses a square structuring element.
     * 
     * @param {Uint8Array} binary - Binary image
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} kernelSize - Size of structuring element (odd number)
     * @returns {Uint8Array} Eroded binary image
     */
    static erode(binary, width, height, kernelSize = 3) {
        const result = new Uint8Array(width * height);
        const half = Math.floor(kernelSize / 2);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let minVal = 255;
                for (let ky = -half; ky <= half; ky++) {
                    for (let kx = -half; kx <= half; kx++) {
                        const ny = y + ky;
                        const nx = x + kx;
                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            if (binary[ny * width + nx] < minVal) {
                                minVal = binary[ny * width + nx];
                            }
                        }
                    }
                }
                result[y * width + x] = minVal;
            }
        }

        return result;
    }

    /**
     * Morphological opening (erode then dilate). Removes small noise.
     */
    static opening(binary, width, height, kernelSize = 3) {
        const eroded = ImageProcessor.erode(binary, width, height, kernelSize);
        return ImageProcessor.dilate(eroded, width, height, kernelSize);
    }

    /**
     * Morphological closing (dilate then erode). Closes small gaps.
     */
    static closing(binary, width, height, kernelSize = 3) {
        const dilated = ImageProcessor.dilate(binary, width, height, kernelSize);
        return ImageProcessor.erode(dilated, width, height, kernelSize);
    }

    // ========================================================================
    // Inversion
    // ========================================================================

    /**
     * Inverts a binary image (0→255, 255→0).
     * Tesseract expects dark text on white background.
     * 
     * @param {Uint8Array} binary - Binary image
     * @returns {Uint8Array} Inverted binary image
     */
    static invert(binary) {
        const result = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            result[i] = 255 - binary[i];
        }
        return result;
    }

    // ========================================================================
    // Contrast Enhancement — CLAHE-like local contrast
    // ========================================================================

    /**
     * Enhances contrast by stretching the intensity range of the image.
     * Maps [min, max] → [0, 255] for maximum dynamic range.
     * 
     * @param {Float32Array} gray - Grayscale values
     * @returns {Float32Array} Contrast-enhanced grayscale values
     */
    static contrastStretch(gray) {
        let min = 255, max = 0;
        for (let i = 0; i < gray.length; i++) {
            if (gray[i] < min) min = gray[i];
            if (gray[i] > max) max = gray[i];
        }

        const range = max - min || 1;
        const result = new Float32Array(gray.length);
        for (let i = 0; i < gray.length; i++) {
            result[i] = ((gray[i] - min) / range) * 255;
        }
        return result;
    }

    // ========================================================================
    // Full Processing Pipelines
    // ========================================================================

    /**
     * Full pre-processing pipeline for OCR cell images.
     * 
     * DESIGN: We use a simple, robust pipeline here:
     *   1. Grayscale the RAW cell content (no white padding)
     *   2. Gaussian blur to reduce noise
     *   3. Otsu threshold (global — works perfectly for bimodal cell images)
     *   4. Smart inversion based on CENTER region intensity
     *   5. Create clean output with white background and dark digit
     * 
     * Key insight: Adaptive thresholding fails on small cell images because
     * uniform dark regions all pass the local mean test. Otsu is ideal
     * because cell images are bimodal (background + digit).
     * 
     * @param {HTMLCanvasElement} canvas - Canvas containing the cell image (raw crop, NO padding)
     * @returns {{ binary: Uint8Array, width: number, height: number, canvas: HTMLCanvasElement }}
     */
    static processForOCR(canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const imageData = ctx.getImageData(0, 0, width, height);

        // Step 1: Grayscale
        ImageProcessor.grayscale(imageData);

        // Step 2: Extract gray channel and blur
        const blurred = ImageProcessor.gaussianBlur(imageData, width, height);

        // Step 3: Contrast stretch on the raw cell (no padding to contaminate range)
        const enhanced = ImageProcessor.contrastStretch(blurred);

        // Step 4: Otsu threshold — perfect for the bimodal distribution
        //         (dark background vs brighter digit)
        const binary = ImageProcessor.otsuThreshold(enhanced, width, height);

        // Step 5: Smart inversion — sample the CENTER region to determine
        //         if digits are currently white-on-black or black-on-white.
        //         We need dark-on-white for Tesseract.
        const cx = Math.floor(width / 2);
        const cy = Math.floor(height / 2);
        const sampleRadius = Math.floor(Math.min(width, height) * 0.15);
        let centerWhite = 0, centerTotal = 0;
        for (let y = cy - sampleRadius; y <= cy + sampleRadius; y++) {
            for (let x = cx - sampleRadius; x <= cx + sampleRadius; x++) {
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    centerTotal++;
                    if (binary[y * width + x] === 255) centerWhite++;
                }
            }
        }
        // If the CENTER is mostly white, the digit is probably white → invert
        // (because background is dominant and if center is white, digit is white)
        // We also check border: if border is mostly black and center has white, invert
        let borderBlack = 0, borderTotal = 0;
        for (let x = 0; x < width; x++) {
            borderTotal += 2;
            if (binary[x] === 0) borderBlack++;  // top row
            if (binary[(height - 1) * width + x] === 0) borderBlack++;  // bottom row
        }
        for (let y = 0; y < height; y++) {
            borderTotal += 2;
            if (binary[y * width] === 0) borderBlack++;  // left col
            if (binary[y * width + (width - 1)] === 0) borderBlack++;  // right col
        }

        // If border is mostly black (dark background) → digits are white → invert
        const borderBlackRatio = borderBlack / borderTotal;
        const finalBinary = borderBlackRatio > 0.6 ? ImageProcessor.invert(binary) : binary;

        // Step 6: Create output canvas with white background padding
        const padded = 100;  // output size
        const padding = 15;  // padding around digit
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = padded;
        outputCanvas.height = padded;
        const outCtx = outputCanvas.getContext('2d');

        // White background
        outCtx.fillStyle = '#ffffff';
        outCtx.fillRect(0, 0, padded, padded);

        // Write binary data centered in the output
        const outData = outCtx.createImageData(width, height);
        for (let i = 0; i < finalBinary.length; i++) {
            outData.data[i * 4] = finalBinary[i];
            outData.data[i * 4 + 1] = finalBinary[i];
            outData.data[i * 4 + 2] = finalBinary[i];
            outData.data[i * 4 + 3] = 255;
        }
        // Put the binary image in a temp canvas, then draw it centered
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = width;
        tmpCanvas.height = height;
        tmpCanvas.getContext('2d').putImageData(outData, 0, 0);

        const drawW = padded - 2 * padding;
        const drawH = padded - 2 * padding;
        outCtx.drawImage(tmpCanvas, 0, 0, width, height, padding, padding, drawW, drawH);

        return { binary: finalBinary, width, height, canvas: outputCanvas };
    }

    /**
     * Lightweight OCR enhancement — just grayscale + contrast, let Tesseract
     * handle binarization internally. Use this as a FALLBACK if processForOCR
     * produces poor results.
     *
     * @param {HTMLCanvasElement} canvas - Raw cell canvas
     * @returns {HTMLCanvasElement} Enhanced canvas
     */
    static enhanceForOCR(canvas) {
        const width = canvas.width;
        const height = canvas.height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, width, height);

        // Grayscale
        ImageProcessor.grayscale(imageData);

        // Boost contrast by stretching histogram
        const data = imageData.data;
        let min = 255, max = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
        }
        const range = max - min || 1;
        for (let i = 0; i < data.length; i += 4) {
            const v = Math.round(((data[i] - min) / range) * 255);
            data[i] = data[i + 1] = data[i + 2] = v;
        }

        const outCanvas = document.createElement('canvas');
        outCanvas.width = width;
        outCanvas.height = height;
        outCanvas.getContext('2d').putImageData(imageData, 0, 0);
        return outCanvas;
    }

    /**
     * Pipeline for grid detection. Produces edge-enhanced binary image.
     * 
     * @param {HTMLCanvasElement} canvas - Canvas containing the full puzzle image
     * @returns {{ gray: Float32Array, binary: Uint8Array, width: number, height: number }}
     */
    static processForGridDetection(canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const imageData = ctx.getImageData(0, 0, width, height);

        // Keep original color data for color-based detection
        const colorData = new Uint8Array(imageData.data);

        // Grayscale
        ImageProcessor.grayscale(imageData);

        // Blur to reduce noise
        const blurred = ImageProcessor.gaussianBlur(imageData, width, height);

        // Adaptive threshold to find grid lines
        const binary = ImageProcessor.adaptiveThreshold(blurred, width, height, 21, 5);

        return { colorData, gray: blurred, binary, width, height };
    }

    /**
     * Creates a canvas from an image URL, scaling to max dimension for performance.
     * 
     * @param {string} imageUrl - Data URL or object URL of the image
     * @param {number} maxDim - Maximum dimension (width or height)
     * @returns {Promise<{canvas: HTMLCanvasElement, scale: number, originalWidth: number, originalHeight: number}>}
     */
    static loadImageToCanvas(imageUrl, maxDim = 800) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const width = Math.round(img.width * scale);
                const height = Math.round(img.height * scale);

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                resolve({ 
                    canvas, 
                    scale, 
                    originalWidth: img.width, 
                    originalHeight: img.height,
                    image: img
                });
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = imageUrl;
        });
    }
}
