/**
 * ============================================================================
 * app.js — Main Application Orchestrator
 * ============================================================================
 * 
 * Coordinates all modules:
 *   1. Image upload (drag-and-drop + click)
 *   2. Image pre-processing (imageProcessor.js)
 *   3. Grid detection (gridDetector.js)
 *   4. OCR digit recognition (ocrEngine.js)
 *   5. Editable grid UI for manual correction
 *   6. Puzzle solving (solver.js)
 *   7. Solution overlay rendering (overlay.js)
 * 
 * UI state management and progress indicators are handled here.
 * 
 * ============================================================================
 */

class MatiksSolverApp {
    constructor() {
        // Module instances
        this.ocrEngine = new OCREngine();
        
        // State
        this.uploadedImage = null;       // The raw Image element
        this.imageCanvas = null;         // Canvas with the loaded image
        this.gridCells = null;           // Detected cell positions
        this.gridDetectionResult = null; // Full grid detection result
        this.ocrGrid = null;             // 6×6 grid from OCR
        this.ocrConfidence = null;       // 6×6 confidence matrix
        this.uncertainCells = [];        // Cells flagged by OCR
        this.solvedGrid = null;          // Solution from solver
        this.imageHash = null;           // For caching

        // DOM references (populated in init())
        this.dom = {};

        // Performance metrics
        this.metrics = {
            preprocessTime: 0,
            gridDetectTime: 0,
            ocrTime: 0,
            solveTime: 0,
            totalTime: 0
        };
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initializes the application: binds DOM elements, sets up event listeners,
     * and starts pre-loading the OCR engine.
     */
    init() {
        // Cache DOM references
        this.dom = {
            dropZone: document.getElementById('drop-zone'),
            fileInput: document.getElementById('file-input'),
            uploadSection: document.getElementById('upload-section'),
            previewSection: document.getElementById('preview-section'),
            resultSection: document.getElementById('result-section'),
            originalCanvas: document.getElementById('original-canvas'),
            resultCanvas: document.getElementById('result-canvas'),
            gridEditor: document.getElementById('grid-editor'),
            gridTable: document.getElementById('grid-table'),
            solveBtn: document.getElementById('solve-btn'),
            resetBtn: document.getElementById('reset-btn'),
            downloadBtn: document.getElementById('download-btn'),
            progressBar: document.getElementById('progress-bar'),
            progressFill: document.getElementById('progress-fill'),
            progressText: document.getElementById('progress-text'),
            statusSteps: document.querySelectorAll('.status-step'),
            toast: document.getElementById('toast'),
            toastMessage: document.getElementById('toast-message'),
            metricsPanel: document.getElementById('metrics-panel'),
            ocrStatus: document.getElementById('ocr-status'),
            // New: stepper elements
            stepUpload: document.getElementById('step-upload'),
            stepProcess: document.getElementById('step-process'),
            stepOCR: document.getElementById('step-ocr'),
            stepSolve: document.getElementById('step-solve'),
            stepDone: document.getElementById('step-done'),
        };

        // Set up event listeners
        this.setupDropZone();
        this.setupButtons();
        this.buildGridEditor();

        // Pre-initialize OCR engine in the background
        this.initOCR();
    }

    /**
     * Pre-initializes the Tesseract.js OCR engine.
     * Runs on page load to amortize the loading time.
     */
    async initOCR() {
        this.updateOCRStatus('loading');
        try {
            await this.ocrEngine.init((progress) => {
                if (progress.stage === 'init') {
                    this.updateOCRStatus('loading', progress.message);
                }
            });
            this.updateOCRStatus('ready');
        } catch (error) {
            console.error('OCR init failed:', error);
            this.updateOCRStatus('error', error.message);
        }
    }

    // ========================================================================
    // Drag & Drop / File Upload
    // ========================================================================

    setupDropZone() {
        const dropZone = this.dom.dropZone;
        const fileInput = this.dom.fileInput;

        // Click to upload
        dropZone.addEventListener('click', () => fileInput.click());

        // File selected via dialog
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleFile(e.target.files[0]);
            }
        });

        // Drag and drop events
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.handleFile(files[0]);
            }
        });

        // Global Paste event for images
        document.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') === 0) {
                    const file = items[i].getAsFile();
                    if (file) {
                        this.handleFile(file);
                        e.preventDefault();
                        break;
                    }
                }
            }
        });
    }

    /**
     * Handles an uploaded file: validates, loads, and starts processing.
     * @param {File} file 
     */
    async handleFile(file) {
        // Validate file type
        if (!file.type.match(/^image\/(png|jpeg|jpg|webp)$/)) {
            this.showToast('Please upload a PNG, JPG, or WebP image.', 'error');
            return;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
            this.showToast('Image is too large. Maximum size is 10MB.', 'error');
            return;
        }

        try {
            this.setStep('upload', 'active');
            this.showProgress('Loading image...');

            // Load image
            const imageUrl = URL.createObjectURL(file);
            const { canvas, scale, image } = await ImageProcessor.loadImageToCanvas(imageUrl, 800);

            this.uploadedImage = image;
            this.imageCanvas = canvas;
            this.imageHash = OCREngine.generateImageHash(canvas);

            // Display the uploaded image
            this.displayOriginalImage(canvas);
            
            this.setStep('upload', 'done');
            this.showSection('preview');

            // Auto-start processing
            await this.processImage();

        } catch (error) {
            console.error('Image load failed:', error);
            this.showToast('Failed to load image. Please try another file.', 'error');
            this.setStep('upload', 'error');
        }
    }

    // ========================================================================
    // Image Processing Pipeline
    // ========================================================================

    /**
     * Full processing pipeline: pre-process → grid detect → OCR → display
     */
    async processImage() {
        const totalStart = performance.now();

        try {
            // ── Step 1: Image Pre-processing ──
            this.setStep('process', 'active');
            this.showProgress('Pre-processing image...');

            const t1 = performance.now();
            const processedData = ImageProcessor.processForGridDetection(this.imageCanvas);
            this.metrics.preprocessTime = performance.now() - t1;

            // ── Step 2: Grid Detection ──
            this.showProgress('Detecting grid...');
            const t2 = performance.now();
            this.gridDetectionResult = GridDetector.detect(this.imageCanvas, processedData);
            this.metrics.gridDetectTime = performance.now() - t2;

            if (!this.gridDetectionResult.success) {
                throw new Error('Could not detect a 6×6 grid in the image. Please ensure the puzzle grid is clearly visible.');
            }

            this.gridCells = this.gridDetectionResult.cells;
            console.log(`🔲 Grid detected via "${this.gridDetectionResult.method}" method in ${this.metrics.gridDetectTime.toFixed(1)}ms`);
            console.log(`   H-lines: [${this.gridDetectionResult.hLines?.join(', ')}]`);
            console.log(`   V-lines: [${this.gridDetectionResult.vLines?.join(', ')}]`);
            console.log(`   Grid bounds:`, this.gridDetectionResult.gridBounds);
            console.log(`   Cells: ${this.gridCells.length} (first: ${JSON.stringify(this.gridCells[0])})`);

            // Extract cell images
            const cellImages = GridDetector.extractCellImages(this.imageCanvas, this.gridCells);
            console.log(`📦 Extracted ${cellImages.length} cell images (${this.imageCanvas.width}×${this.imageCanvas.height} source)`);

            this.setStep('process', 'done');

            // ── Step 3: OCR ──
            this.setStep('ocr', 'active');
            this.showProgress('Reading digits...');

            const t3 = performance.now();
            
            // Ensure OCR is initialized
            if (!this.ocrEngine.initialized) {
                this.showProgress('Initializing OCR engine...');
                await this.ocrEngine.init((progress) => {
                    this.showProgress(progress.message, progress.progress);
                });
            }

            const ocrResult = await this.ocrEngine.recognizeGrid(cellImages, this.imageHash);
            this.metrics.ocrTime = performance.now() - t3;

            this.ocrGrid = ocrResult.grid;
            this.ocrConfidence = ocrResult.confidence;
            this.uncertainCells = ocrResult.uncertainCells;

            console.log(`OCR completed in ${this.metrics.ocrTime.toFixed(1)}ms`);
            console.log('Detected grid:', JSON.stringify(this.ocrGrid));

            this.setStep('ocr', 'done');

            // ── Step 4: Display results ──
            this.populateGridEditor(this.ocrGrid, this.ocrConfidence, this.uncertainCells);
            this.showSection('result');

            this.metrics.totalTime = performance.now() - totalStart;
            this.showProgress(`Ready! (${this.metrics.totalTime.toFixed(0)}ms)`);
            this.updateMetrics();

            if (this.uncertainCells.length > 0) {
                this.showToast(`${this.uncertainCells.length} cell(s) had low OCR confidence. Auto-solving anyway...`, 'warning');
            } else {
                this.showToast('All digits recognized successfully! Auto-solving...', 'success');
            }

            // Automatically solve the puzzle
            await this.solvePuzzle();

        } catch (error) {
            console.error('Processing failed:', error);
            this.showToast(error.message, 'error');
            this.setStep('process', 'error');
        }
    }

    // ========================================================================
    // Solving
    // ========================================================================

    /**
     * Reads the grid from the editor, validates, solves, and renders overlay.
     */
    async solvePuzzle() {
        try {
            this.setStep('solve', 'active');
            this.showProgress('Solving puzzle...');

            // Read the current grid from the editor (user may have corrected values)
            const currentGrid = this.readGridFromEditor();

            // Solve
            const t = performance.now();
            const result = SudokuSolver.quickSolve(currentGrid);
            this.metrics.solveTime = performance.now() - t;

            if (!result.solved) {
                this.setStep('solve', 'error');
                const errorMsg = result.errors.join(' ');
                this.showToast(`Cannot solve: ${errorMsg}`, 'error');
                return;
            }

            this.solvedGrid = result.grid;
            console.log(`Solved in ${this.metrics.solveTime.toFixed(3)}ms (${result.nodesExplored} nodes explored)`);

            // Render the solution overlay
            SolutionOverlay.render(
                this.dom.resultCanvas,
                this.uploadedImage,
                this.gridCells,
                currentGrid,
                this.solvedGrid,
                this.uncertainCells
            );

            this.setStep('solve', 'done');
            this.setStep('done', 'done');

            // Update the grid editor with solved values
            this.populateGridEditor(this.solvedGrid, null, [], currentGrid);

            this.showProgress(`Solved in ${this.metrics.solveTime.toFixed(2)}ms!`);
            this.showToast(`Puzzle solved in ${this.metrics.solveTime.toFixed(2)}ms! (${result.nodesExplored} nodes explored)`, 'success');

            // Show download and result
            this.dom.downloadBtn.style.display = 'inline-flex';
            this.dom.resultCanvas.style.display = 'block';
            this.updateMetrics();

        } catch (error) {
            console.error('Solve failed:', error);
            this.showToast(`Solving error: ${error.message}`, 'error');
            this.setStep('solve', 'error');
        }
    }

    // ========================================================================
    // Grid Editor UI
    // ========================================================================

    /**
     * Builds the 6×6 editable grid table.
     */
    buildGridEditor() {
        const table = this.dom.gridTable;
        table.innerHTML = '';

        for (let r = 0; r < 6; r++) {
            const tr = document.createElement('tr');
            // Add thicker border between box rows (every 2 rows for 2×3 boxes)
            if (r > 0 && r % 2 === 0) {
                tr.classList.add('box-border-top');
            }

            for (let c = 0; c < 6; c++) {
                const td = document.createElement('td');
                // Add thicker border between box columns (every 3 cols for 2×3 boxes)
                if (c > 0 && c % 3 === 0) {
                    td.classList.add('box-border-left');
                }

                const input = document.createElement('input');
                input.type = 'text';
                input.maxLength = 1;
                input.id = `cell-${r}-${c}`;
                input.dataset.row = r;
                input.dataset.col = c;
                input.setAttribute('autocomplete', 'off');

                // Input validation: only allow 1-6 or empty
                input.addEventListener('input', (e) => {
                    const val = e.target.value;
                    if (val && (!/^[1-6]$/.test(val))) {
                        e.target.value = '';
                    }
                    // Remove uncertainty styling on manual edit
                    e.target.parentElement.classList.remove('uncertain');
                    e.target.classList.remove('uncertain-input');
                });

                // Auto-advance to next cell
                input.addEventListener('keydown', (e) => {
                    if (e.key >= '1' && e.key <= '6') {
                        // Move to next cell
                        const nextC = c + 1;
                        const nextR = nextC >= 6 ? r + 1 : r;
                        const nextCol = nextC % 6;
                        if (nextR < 6) {
                            setTimeout(() => {
                                document.getElementById(`cell-${nextR}-${nextCol}`)?.focus();
                            }, 50);
                        }
                    } else if (e.key === 'Backspace' && !e.target.value) {
                        // Move to previous cell
                        const prevC = c - 1;
                        const prevR = prevC < 0 ? r - 1 : r;
                        const prevCol = prevC < 0 ? 5 : prevC;
                        if (prevR >= 0) {
                            document.getElementById(`cell-${prevR}-${prevCol}`)?.focus();
                        }
                    } else if (e.key === 'ArrowRight') {
                        const next = document.getElementById(`cell-${r}-${Math.min(5, c + 1)}`);
                        next?.focus();
                    } else if (e.key === 'ArrowLeft') {
                        const prev = document.getElementById(`cell-${r}-${Math.max(0, c - 1)}`);
                        prev?.focus();
                    } else if (e.key === 'ArrowDown') {
                        const below = document.getElementById(`cell-${Math.min(5, r + 1)}-${c}`);
                        below?.focus();
                    } else if (e.key === 'ArrowUp') {
                        const above = document.getElementById(`cell-${Math.max(0, r - 1)}-${c}`);
                        above?.focus();
                    }
                });

                td.appendChild(input);
                tr.appendChild(td);
            }
            table.appendChild(tr);
        }
    }

    /**
     * Populates the grid editor with recognized values.
     * 
     * @param {number[][]} grid - The digit grid
     * @param {number[][]|null} confidence - Confidence levels (null after solving)
     * @param {Array} uncertainCells - Uncertain cells
     * @param {number[][]|null} originalGrid - Original grid (for highlighting solved cells)
     */
    populateGridEditor(grid, confidence, uncertainCells = [], originalGrid = null) {
        const uncertainSet = new Set(uncertainCells.map(c => `${c.row},${c.col}`));

        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 6; c++) {
                const input = document.getElementById(`cell-${r}-${c}`);
                const td = input.parentElement;
                
                // Clear previous classes
                td.classList.remove('uncertain', 'given', 'solved');
                input.classList.remove('uncertain-input', 'given-input', 'solved-input');

                const val = grid[r][c];
                input.value = val > 0 ? String(val) : '';

                if (uncertainSet.has(`${r},${c}`)) {
                    td.classList.add('uncertain');
                    input.classList.add('uncertain-input');
                } else if (originalGrid && originalGrid[r][c] === 0 && val > 0) {
                    // Solved cell
                    td.classList.add('solved');
                    input.classList.add('solved-input');
                    input.readOnly = true;
                } else if (val > 0) {
                    // Given cell
                    td.classList.add('given');
                    input.classList.add('given-input');
                }
            }
        }
    }

    /**
     * Reads the current grid values from the editor inputs.
     * @returns {number[][]} 6×6 grid
     */
    readGridFromEditor() {
        const grid = Array.from({ length: 6 }, () => Array(6).fill(0));
        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 6; c++) {
                const input = document.getElementById(`cell-${r}-${c}`);
                const val = parseInt(input.value);
                grid[r][c] = (val >= 1 && val <= 6) ? val : 0;
            }
        }
        return grid;
    }

    // ========================================================================
    // Button Handlers
    // ========================================================================

    setupButtons() {
        this.dom.solveBtn.addEventListener('click', () => this.solvePuzzle());
        
        this.dom.resetBtn.addEventListener('click', () => this.reset());
        
        this.dom.downloadBtn.addEventListener('click', () => {
            SolutionOverlay.downloadSolution(this.dom.resultCanvas);
        });
    }

    /**
     * Resets the app to initial state.
     */
    reset() {
        // Clear state
        this.uploadedImage = null;
        this.imageCanvas = null;
        this.gridCells = null;
        this.gridDetectionResult = null;
        this.ocrGrid = null;
        this.ocrConfidence = null;
        this.uncertainCells = [];
        this.solvedGrid = null;
        this.imageHash = null;
        this.metrics = { preprocessTime: 0, gridDetectTime: 0, ocrTime: 0, solveTime: 0, totalTime: 0 };

        // Reset DOM
        this.dom.fileInput.value = '';
        this.dom.originalCanvas.getContext('2d').clearRect(0, 0, this.dom.originalCanvas.width, this.dom.originalCanvas.height);
        this.dom.resultCanvas.getContext('2d').clearRect(0, 0, this.dom.resultCanvas.width, this.dom.resultCanvas.height);
        this.dom.resultCanvas.style.display = 'none';
        this.dom.downloadBtn.style.display = 'none';

        // Reset grid editor
        this.buildGridEditor();

        // Reset steps
        this.dom.statusSteps.forEach(step => {
            step.classList.remove('active', 'done', 'error');
        });

        // Reset progress
        this.hideProgress();

        // Show upload section
        this.showSection('upload');
        this.updateMetrics();
    }

    // ========================================================================
    // UI Helpers
    // ========================================================================

    displayOriginalImage(canvas) {
        const display = this.dom.originalCanvas;
        display.width = canvas.width;
        display.height = canvas.height;
        const ctx = display.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
    }

    showSection(section) {
        this.dom.uploadSection.classList.toggle('hidden', section !== 'upload');
        this.dom.previewSection.classList.toggle('hidden', section === 'upload');
        this.dom.resultSection.classList.toggle('hidden', section === 'upload');
    }

    setStep(stepName, state) {
        const stepEl = this.dom[`step${stepName.charAt(0).toUpperCase() + stepName.slice(1)}`];
        if (!stepEl) return;

        stepEl.classList.remove('active', 'done', 'error');
        if (state) stepEl.classList.add(state);
    }

    showProgress(message, progress = null) {
        this.dom.progressBar.style.display = 'flex';
        this.dom.progressText.textContent = message;
        if (progress !== null) {
            this.dom.progressFill.style.width = `${Math.round(progress * 100)}%`;
        } else {
            this.dom.progressFill.style.width = '100%';
            this.dom.progressFill.classList.add('indeterminate');
        }
    }

    hideProgress() {
        this.dom.progressBar.style.display = 'none';
        this.dom.progressFill.classList.remove('indeterminate');
        this.dom.progressFill.style.width = '0%';
    }

    showToast(message, type = 'info') {
        const toast = this.dom.toast;
        const msg = this.dom.toastMessage;

        msg.textContent = message;
        toast.className = `toast show ${type}`;

        // Auto-hide after 5 seconds
        clearTimeout(this._toastTimeout);
        this._toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, 5000);
    }

    updateOCRStatus(status, message = '') {
        const el = this.dom.ocrStatus;
        if (!el) return;

        switch (status) {
            case 'loading':
                el.innerHTML = `<span class="status-dot loading"></span> ${message || 'Loading OCR engine...'}`;
                break;
            case 'ready':
                el.innerHTML = '<span class="status-dot ready"></span> OCR engine ready';
                break;
            case 'error':
                el.innerHTML = `<span class="status-dot error"></span> OCR error: ${message}`;
                break;
        }
    }

    updateMetrics() {
        const el = this.dom.metricsPanel;
        if (!el) return;

        el.innerHTML = `
            <div class="metric">
                <span class="metric-label">Pre-process</span>
                <span class="metric-value">${this.metrics.preprocessTime.toFixed(1)}ms</span>
            </div>
            <div class="metric">
                <span class="metric-label">Grid Detect</span>
                <span class="metric-value">${this.metrics.gridDetectTime.toFixed(1)}ms</span>
            </div>
            <div class="metric">
                <span class="metric-label">OCR</span>
                <span class="metric-value">${this.metrics.ocrTime.toFixed(0)}ms</span>
            </div>
            <div class="metric">
                <span class="metric-label">Solver</span>
                <span class="metric-value">${this.metrics.solveTime.toFixed(2)}ms</span>
            </div>
            <div class="metric total">
                <span class="metric-label">Total</span>
                <span class="metric-value">${this.metrics.totalTime.toFixed(0)}ms</span>
            </div>
        `;
    }
}

// ============================================================================
// Bootstrap
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    const app = new MatiksSolverApp();
    app.init();

    // Expose for debugging
    window.matiksSolver = app;
});
