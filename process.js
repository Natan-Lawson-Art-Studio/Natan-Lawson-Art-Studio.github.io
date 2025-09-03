// ---------- Helpers ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const els = id => document.getElementById(id);
let layersVisible = [];        // boolean flags per layer
let segCache = new Map();      // cache segments per layer + settings to avoid recompute

// Filename helpers
function sanitizeStem(stem){
  let s = (stem||'').trim().replace(/\s+/g,'_');
  s = s.replace(/[^A-Za-z0-9._-]+/g,'-');
  s = s.replace(/-+/g,'-');
  s = s.replace(/^[\-.]+|[\-.]+$/g,'');
  return s || 'image';
}
function makeSlug(name){
  let s = (name||'').toLowerCase().trim().replace(/\s+/g,'-');
  s = s.replace(/[^a-z0-9._-]+/g,'-');
  s = s.replace(/-+/g,'-');
  s = s.replace(/^[\-.]+|[\-.]+$/g,'');
  return s || 'layer';
}

function hexFromRGB([r,g,b]){
  return `#${Math.round(r).toString(16).padStart(2,'0')}${Math.round(g).toString(16).padStart(2,'0')}${Math.round(b).toString(16).padStart(2,'0')}`;
}

function currentSettingsKey(idx, angle, spacingPx, xh, xha) {
  // cache key per layer and hatch settings
  return `${idx}|${angle}|${spacingPx}|${xh?'1':'0'}|${xha}`;
}

function getLayerSegments(idx, angle, spacingPx, xh, xha) {
  const key = currentSettingsKey(idx, angle, spacingPx, xh, xha);
  if (segCache.has(key)) return segCache.get(key);

  const invert = els('invert').value==='1';
  const mask = buildMaskForLabel(idx, invert);
  const segA = buildHatchSegments(mask, W, H, angle, spacingPx);
  const segs = xh ? segA.concat(buildHatchSegments(mask, W, H, xha, spacingPx)) : segA;

  segCache.set(key, segs);
  return segs;
}


function arrayShufflePick(arr, max) { // pick up to max random items
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){const j=(Math.random()* (i+1))|0; [a[i],a[j]]=[a[j],a[i]]}
  return a.slice(0, max);
}

function cleanHex(hex) {
  // Remove any decimal parts and ensure proper format
  hex = hex.split('.')[0]; // Remove everything after decimal
  if (!hex.startsWith('#')) hex = '#' + hex;
  return hex.slice(0, 7); // Keep only #RRGGBB
}

function rgb2name([r, g, b]) {
  let hex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  hex = cleanHex(hex);
  return ntc.name(hex)[1];
}

// ---------- Read embedded DPI ----------
async function detectPPI(file){
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // PNG pHYs
  const isPNG = bytes[0]==0x89 && bytes[1]==0x50 && bytes[2]==0x4E && bytes[3]==0x47;
  if(isPNG){
    // scan chunks
    let p=8; // skip signature
    while(p+8 < bytes.length){
      const len = (bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];
      const type = String.fromCharCode(bytes[p+4],bytes[p+5],bytes[p+6],bytes[p+7]);
      if(type==='pHYs' && len>=9){
        const xppm = (bytes[p+8]<<24)|(bytes[p+9]<<16)|(bytes[p+10]<<8)|bytes[p+11];
        const unit = bytes[p+16]; // 1=meters
        if(unit===1){ const ppi = ((xppm>>>0) * 0.0254); return clamp(ppi,50,1200); }
      }
      p += 12 + len; // 4 len + 4 type + len + 4 crc
    }
  }
  // JPEG JFIF/EXIF
  const isJPG = bytes[0]==0xFF && bytes[1]==0xD8;
  if(isJPG){
    let p=2;
    while(p+4<bytes.length){
      if(bytes[p]!=0xFF) break; const marker = bytes[p+1]; const size = (bytes[p+2]<<8)|bytes[p+3];
      if(marker==0xE0 && size>=16){ // APP0 JFIF
        const id = String.fromCharCode(bytes[p+4],bytes[p+5],bytes[p+6],bytes[p+7],bytes[p+8]);
        if(id.startsWith('JFIF')){
          const units = bytes[p+9]; const xden = (bytes[p+10]<<8)|bytes[p+11]; const yden = (bytes[p+12]<<8)|bytes[p+13];
          if(units==1){ return clamp((xden+yden)/2,50,1200); }
          if(units==2){ return clamp(((xden+yden)/2)*2.54,50,1200); }
        }
      }
      // APP1 EXIF would need TIFF parsing; skipping for brevity
      if(marker==0xDA) break; // SOS
      p += 2 + size;
    }
  }
  return null;
}



// ---------- Hatching ----------
function buildHatchSegments(mask, W, H, angleDeg, spacing){
  // mask: Uint8Array (0/1) length W*H
  const rad = angleDeg * Math.PI/180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const nx = -sin, ny = cos; // normal vector
  // project bbox corners onto normal to get range of c
  const corners=[[0,0],[W,0],[0,H],[W,H]];
  let cmin=Infinity, cmax=-Infinity;
  for(const [x,y] of corners){ const c = nx*x + ny*y; if(c<cmin) cmin=c; if(c>cmax) cmax=c; }
  const pad = spacing*2; cmin-=pad; cmax+=pad;
  const segments = [];
  for(let c=cmin; c<=cmax; c+=spacing){
    // parametric line: n·p = c; direction along tangent t=(cos,sin)
    const L = Math.hypot(W,H) + 2*pad; // span length
    // Find a point on the line near center
    const cx=W/2, cy=H/2; const dc = nx*cx + ny*cy; const shift = c - dc;
    const x0 = cx + nx*shift; const y0 = cy + ny*shift;
    // March along tangent both directions in steps ~1px
    const step = 1; // px
    let prevInside=false, runStart=null;
    for(let s=-L/2; s<=L/2; s+=step){
      const x = x0 + cos*s, y = y0 + sin*s;
      const xi = Math.round(x), yi = Math.round(y);
      const inside = (xi>=0 && yi>=0 && xi<W && yi<H) && (mask[yi*W+xi]===1);
      if(inside && !prevInside){ runStart = [x,y]; }
      if(!inside && prevInside && runStart){ segments.push([runStart, [x,y]]); runStart=null; }
      prevInside = inside;
    }
    if(prevInside && runStart){ segments.push([runStart, [x0 + cos*(L/2), y0 + sin*(L/2)]]); }
  }
  return segments;
}

function svgFromSegments(segments, W, H, ppi, strokePx, borderPx, rgbColor){
  const totalWpx = W + 2*(borderPx||0);
  const totalHpx = H + 2*(borderPx||0);
  const widthMM = (totalWpx/ppi)*25.4, heightMM=(totalHpx/ppi)*25.4;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${widthMM.toFixed(3)}mm" height="${heightMM.toFixed(3)}mm" viewBox="0 0 ${totalWpx} ${totalHpx}">`];
  if(borderPx>0){ parts.push(`<g transform="translate(${borderPx.toFixed(2)},${borderPx.toFixed(2)})">`); }
  
  // Convert RGB color to hex format
  const hexColor = `#${Math.round(rgbColor[0]).toString(16).padStart(2, '0')}${Math.round(rgbColor[1]).toString(16).padStart(2, '0')}${Math.round(rgbColor[2]).toString(16).padStart(2, '0')}`;
  
  for(const seg of segments){
    const [[x1,y1],[x2,y2]] = seg;
    parts.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${hexColor}" stroke-width="${strokePx}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
  }
  if(borderPx>0){ parts.push(`</g>`); }
  parts.push(`</svg>`);
  return parts.join("");
}

// ---------- PCA for 3D→2D projection ----------
function pcaProjection(data) {
  // Simple PCA implementation for RGB→2D projection
  const n = data.length;
  
  // Center the data
  const mean = [0, 0, 0];
  data.forEach(v => {
    mean[0] += v[0];
    mean[1] += v[1];
    mean[2] += v[2];
  });
  mean[0] /= n; mean[1] /= n; mean[2] /= n;
  
  const centered = data.map(v => [v[0] - mean[0], v[1] - mean[1], v[2] - mean[2]]);
  
  // Compute covariance matrix
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  
  centered.forEach(v => {
    cov[0][0] += v[0] * v[0];
    cov[0][1] += v[0] * v[1];
    cov[0][2] += v[0] * v[2];
    cov[1][0] += v[1] * v[0];
    cov[1][1] += v[1] * v[1];
    cov[1][2] += v[1] * v[2];
    cov[2][0] += v[2] * v[0];
    cov[2][1] += v[2] * v[1];
    cov[2][2] += v[2] * v[2];
  });
  
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      cov[i][j] /= n;
    }
  }
  
  // Simple eigenvector approximation (first two principal components)
  // For simplicity, we'll use the first two dimensions (R and G) as our projection
  // This gives a reasonable 2D visualization of the color space
  return data.map(v => [v[0] / 255, v[1] / 255]); // Normalize to 0-1 range
}

// ---------- Chart Visualization ----------
function drawClusterChart(sampleData, labels, centers, k) {
  const canvas = els('clusterChart');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = 40;
  const chartWidth = width - 2 * padding;
  const chartHeight = height - 2 * padding;
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height);
  
  // Project data to 2D
  const projectedData = pcaProjection(sampleData);
  
  // Find data bounds
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  
  projectedData.forEach(([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  
  // Add some padding to bounds
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;
  minX -= xRange * 0.1;
  maxX += xRange * 0.1;
  minY -= yRange * 0.1;
  maxY += yRange * 0.1;
  
  // Scale function
  const scaleX = x => padding + ((x - minX) / (maxX - minX)) * chartWidth;
  const scaleY = y => height - padding - ((y - minY) / (maxY - minY)) * chartHeight;
  
  // Draw grid
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 1; i += 0.2) {
    const x = scaleX(minX + i * (maxX - minX));
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height - padding);
    
    const y = scaleY(minY + i * (maxY - minY));
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
  }
  ctx.stroke();
  
  // Draw axes
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, height - padding);
  ctx.lineTo(width - padding, height - padding);
  ctx.stroke();
  
  // Draw points with actual cluster mean colors
  projectedData.forEach((point, i) => {
    const cluster = labels[i];
    const [x, y] = point;
    const rgb = centers[cluster];
    
    // Use the actual cluster color with some transparency
    ctx.fillStyle = `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, 0.7)`;
    ctx.beginPath();
    ctx.arc(scaleX(x), scaleY(y), 4, 0, 2 * Math.PI);
    ctx.fill();
  });
  
  // Draw centroids if enabled
  if (els('showCentroids').checked) {
    const projectedCenters = pcaProjection(centers);
    
    projectedCenters.forEach((point, i) => {
      const [x, y] = point;
      const rgb = centers[i];
      
      // Draw centroid circle with actual cluster color
      ctx.fillStyle = `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
      ctx.beginPath();
      ctx.arc(scaleX(x), scaleY(y), 8, 0, 2 * Math.PI);
      ctx.fill();
      
      // Add black border for better visibility
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Draw cluster label if enabled
      if (els('showLabels').checked) {
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`Cluster ${i + 1}`, scaleX(x), scaleY(y) - 15);
      }
    });
  }
  
  // Draw axis labels
  ctx.fillStyle = '#666';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Red Component', width / 2, height - 10);
  ctx.textAlign = 'right';
  ctx.fillText('Green Component', 30, height / 2);
}

// ---------- 3D Visualization with Three.js ----------
let scene, camera, renderer, controls;
let animationId = null;

function initThreeDScene() {
  const container = els('threeDContainer');
  
  // Clear previous scene if it exists
  if (renderer) {
    container.innerHTML = '';
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }
  
  // Create scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf8f9fa);
  
  // Create camera
  camera = new THREE.PerspectiveCamera(75, 400 / 400, 0.1, 1000);
  camera.position.set(200, 200, 300);
  
  // Create renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(400, 400);
  container.appendChild(renderer.domElement);
  
  // Add orbit controls - Note: You'll need to include OrbitControls in your HTML
  // <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/controls/OrbitControls.js"></script>
  if (typeof THREE.OrbitControls !== 'undefined') {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
  }
  
  // Add ambient light
  const ambientLight = new THREE.AmbientLight(0x404040, 0.8);
  scene.add(ambientLight);
  
  // Add directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
}

function createColorVisualization(sampleData, centers, density) {
  // Clear existing visualization objects
  scene.children.filter(child => child.userData.isVisualizationObject).forEach(obj => scene.remove(obj));
  
  // Calculate the actual percentage of original image pixels to show
  const totalPixels = W * H;
  let targetPixelCount = Math.max(1, Math.floor(totalPixels * (density / 100)));
  
  // Increase performance cap for better point cloud visualization
  const MAX_PIXELS_FOR_PERFORMANCE = 100000; // Increased limit
  if (targetPixelCount > MAX_PIXELS_FOR_PERFORMANCE) {
    targetPixelCount = MAX_PIXELS_FOR_PERFORMANCE;
    const actualPercentage = Math.min(density, (MAX_PIXELS_FOR_PERFORMANCE / totalPixels) * 100);
    els('densityValue').textContent = `${actualPercentage.toFixed(1)}% (${targetPixelCount.toLocaleString()} of ${totalPixels.toLocaleString()} pixels, capped for performance)`;
  }
  
  let visualizationData;
  
  if (targetPixelCount <= sampleData.length) {
    visualizationData = arrayShufflePick(sampleData, targetPixelCount);
  } else {
    const idxs = arrayShufflePick([...Array(totalPixels).keys()], targetPixelCount);
    visualizationData = idxs.map(i => [
      pixels[i * 4], 
      pixels[i * 4 + 1], 
      pixels[i * 4 + 2]
    ]);
  }
  
  // Use individual points instead of instanced mesh for better color control
  const pointsGeometry = new THREE.BufferGeometry();
  const positions = [];
  const colors = [];
  
  for (let i = 0; i < visualizationData.length; i++) {
    const [r, g, b] = visualizationData[i];
    
    // Position in RGB space (centered around origin)
    positions.push(r - 127.5, g - 127.5, b - 127.5);
    
    // Color (normalized to 0-1)
    colors.push(r / 255, g / 255, b / 255);
  }
  
  pointsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  pointsGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  
  // Create points material
  const pointsMaterial = new THREE.PointsMaterial({
    size: 2.5, // Point size in pixels
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: false // Keep consistent size regardless of distance
  });
  
  const pointCloud = new THREE.Points(pointsGeometry, pointsMaterial);
  pointCloud.userData.isVisualizationObject = true;
  pointCloud.userData.type = 'pixels';
  scene.add(pointCloud);
  
  // Create spheres for k-means centroids
  if (centers && centers.length > 0) {
    const sphereGeometry = new THREE.SphereGeometry(32, 16, 16);
    
    centers.forEach((rgb, index) => {
      const [r, g, b] = rgb;
      
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(r / 255, g / 255, b / 255),
        transparent: false
      });
      
      const sphere = new THREE.Mesh(sphereGeometry, material);
      sphere.userData.isVisualizationObject = true;
      sphere.userData.type = 'centroid';
      
      // Position in RGB space (centered around origin)
      sphere.position.set(r - 127.5, g - 127.5, b - 127.5);
            
      scene.add(sphere);
    });
  }
  
  // Create wireframe cube showing RGB space bounds
  const cubeSize = 255;
  const cubeGeometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
  const cubeMaterial = new THREE.MeshBasicMaterial({
    color: 0x666666,
    wireframe: true,
    transparent: true,
    opacity: 0.2
  });
  
  const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
  cube.userData.isVisualizationObject = true;
  cube.userData.type = 'boundingCube';
  cube.position.set(0, 0, 0);
  scene.add(cube);
}

function animate() {
  animationId = requestAnimationFrame(animate);
  
  if (els('animateRotation').checked) {
    scene.rotation.y += 0.005;
  }
  
  if (controls) {
    controls.update();
  }
  renderer.render(scene, camera);
}

function update3DVisualization(sampleData, centers) {
  const density = parseInt(els('sampleDensity').value);
  const totalPixels = W * H;
  const targetPixelCount = Math.max(1, Math.floor(totalPixels * (density / 100)));
  
  els('densityValue').textContent = `${density}% (${targetPixelCount.toLocaleString()} of ${totalPixels.toLocaleString()} pixels)`;
  
  initThreeDScene();
  createColorVisualization(sampleData, centers, density);
  animate();
}

// Event listeners remain the same
els('sampleDensity').addEventListener('input', () => {
  if (sampleDataFor3D && centers) {
    const density = parseInt(els('sampleDensity').value);
    const totalPixels = W * H;
    const targetPixelCount = Math.max(1, Math.floor(totalPixels * (density / 100)));
    els('densityValue').textContent = `${density}% (${targetPixelCount.toLocaleString()} of ${totalPixels.toLocaleString()} pixels)`;
    createColorVisualization(sampleDataFor3D, centers, density);
  }
});

els('animateRotation').addEventListener('change', () => {
  if (!els('animateRotation').checked && animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  } else if (els('animateRotation').checked && !animationId && renderer) {
    animate();
  }
});

// ---------- Drag and Drop Functionality ----------
function setupDragAndDrop() {
  const previewContainer = document.getElementById('previewContainer');
  const dropText = document.getElementById('dropText');
  const previewImg = document.getElementById('preview');
  const fileInput = document.getElementById('file');

  // Click to upload
  previewContainer.addEventListener('click', () => {
    fileInput.click();
  });

  // Drag and drop events
  previewContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    previewContainer.style.borderColor = '#007bff';
    previewContainer.style.backgroundColor = '#f0f8ff';
    dropText.style.color = '#007bff';
  });

  previewContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    previewContainer.style.borderColor = '#ddd';
    previewContainer.style.backgroundColor = '#fafafa';
    dropText.style.color = '#666';
  });

  previewContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    previewContainer.style.borderColor = '#ddd';
    previewContainer.style.backgroundColor = '#fafafa';
    dropText.style.color = '#666';

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      handleFileUpload(files[0]);
    }
  });

  // File input change event
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFileUpload(file);
    }
  });
}

async function handleFileUpload(file) {
  const dropText = document.getElementById('dropText');
  const previewImg = document.getElementById('preview');
  
  // Hide drop text when image is loaded
  dropText.style.display = 'none';
  
  fileObj = file;
  sourceBase = sanitizeStem(file.name.replace(/\.[^.]+$/, ""));
  detectedPPI = await detectPPI(file);
  const url = URL.createObjectURL(file);
  const im = new Image();
  
  im.onload = () => {
    img = im;
    W = im.naturalWidth;
    H = im.naturalHeight;
    previewImg.src = url;
    const cvs = document.createElement('canvas');
    cvs.width = W;
    cvs.height = H;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(im, 0, 0);
    pixels = ctx.getImageData(0, 0, W, H).data; // RGBA
    updateSizeUI();
  };
  
  im.src = url;
}

// ---------- State ----------
let img=null, W=0, H=0, pixels=null, fileObj=null, detectedPPI=null, labelMap=null, centers=null, sourceBase='image';
let sampleDataFor3D = null;

const fileEl = els('file');
fileEl.addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  fileObj=f;
  // derive source base name from uploaded file
  sourceBase = sanitizeStem(f.name.replace(/\.[^.]+$/, ""));
  detectedPPI = await detectPPI(f);
  const url = URL.createObjectURL(f);
  const im = new Image();
    im.onload = ()=>{
    img = im; W=im.naturalWidth; H=im.naturalHeight;
    els('preview').src = url;
    const cvs=document.createElement('canvas'); cvs.width=W; cvs.height=H;
    const ctx=cvs.getContext('2d'); ctx.drawImage(im,0,0);
    pixels = ctx.getImageData(0,0,W,H).data; // RGBA
    updateSizeUI();
  };
  im.src=url;
});

function updateSizeUI(){
  setExportInfo();
  updateImageMetadata(detectedPPI);
}
['borderOn','borderSize','borderUnits'].forEach(id=>{
  els(id).addEventListener('change',()=>{ if(!img) return; updateSizeUI(); });
});
['gAngle','gSpacing','gStrokeWidth','gCross','gCrossAngle','invert'].forEach(id=>{
  els(id).addEventListener('change', ()=>{
    segCache.clear();   // settings changed; invalidate cache
    if (centers) {
      // Rebuild the per-layer previews quickly (they’re regenerated next analyze; here we just refresh composite)
      if (typeof renderComposite === 'function') {
        // in case we’re outside analyzeImage scope, do a safe recompute using top-level helpers:
        try {
          // Minimal recompute of composite
          const ppi = computeUsedPPI();
          const strokeWidthMM = Number(els('gStrokeWidth').value);
          const strokePx = (strokeWidthMM / 25.4) * ppi;
          const bpx = getBorderPx(ppi);
          const indices = centers.map((_,i)=>i).filter(i=>layersVisible[i]);
          if (indices.length){
            const svg = svgComposite(indices, W, H, ppi, strokePx, bpx, centers);
            renderCompositeInto('compositePreview', svg);
          }
        } catch(e){}
      }
    }
  });
});

function computeUsedPPI(){
  return detectedPPI ?? 300; 
}

function getBorderPx(ppi){
  if(els('borderOn').value==='No') return 0;
  const v = Number(els('borderSize').value)||0;
  const u = els('borderUnits').value;
  if(u==='in') return v*ppi;
  if(u==='mm') return (v/25.4)*ppi;
  return 0;
}

function setExportInfo(){
  const ppi=computeUsedPPI();
  const b = getBorderPx(ppi);
  const wIn=(W + 2*b)/ppi, hIn=(H + 2*b)/ppi;
  els('exportInfo').textContent = `SVG export size ≈ ${wIn.toFixed(3)} in × ${hIn.toFixed(3)} in @ ${ppi.toFixed(2)} PPI${b>0? ' (includes blank border)':''}.`;
}

// Update image metadata display with simplified format
function updateImageMetadata(ppi){
  if(!img) return;
  
  const currentPPI = ppi || computeUsedPPI();
  const widthIn = W / currentPPI;
  const heightIn = H / currentPPI;
  
  let metadataText = `Artwork Size: ${widthIn.toFixed(1)}" × ${heightIn.toFixed(1)}" (${currentPPI.toFixed(0)} DPI)`;
  
  els('imgMeta').textContent = metadataText;
}

// Loading functions
function showLoading(text, progress) {
  els('loadingContainer').style.display = 'flex';
  els('loadingText').textContent = text;
  els('loadingProgress').style.width = `${progress}%`;
}

function hideLoading() {
  els('loadingContainer').style.display = 'none';
}
async function analyzeImage(){
  if(!fileObj){ els('err').textContent = 'Please select a PNG or JPEG first.'; return; }
  els('err').textContent='';
  if(!img) return;

  // Show loading
  showLoading('Sampling image colors...', 10);

  const invert = els('invert').value==='1';
  const total = W*H; 
  const maxSample = Math.min(total, 200000);

  // Allow UI to paint
  await new Promise(r => setTimeout(r, 50));

  showLoading('Sampling image colors...', 30);
  const idxs = arrayShufflePick([...Array(total).keys()], maxSample);
  const sample = idxs.map(i => [pixels[i*4], pixels[i*4+1], pixels[i*4+2]]);

  // Decide k
  let kRaw = Number(els('k').value)|0; 
  let k;
  if(kRaw<=0){
    const uniq = new Set(sample.map(v => (v[0]<<16)|(v[1]<<8)|v[2]));
    const est = Math.round(Math.sqrt(uniq.size));
    k = clamp(est,2,12);
  } else { 
    k = clamp(kRaw,2,12); 
  }

  showLoading('Running K-Means clustering...', 50);
  await new Promise(r => setTimeout(r, 50));

  // Run k-means (TensorFlow impl returns centers + labels for the sample set)
  const { centers: c, labelsSample } = await tfKMeans(sample, k, { iters: 15, tolerance: 0.5 });
  let centersLocal = c.map(v => [v[0], v[1], v[2]]);
  let labels = labelsSample.slice(); // mutable copy for remap

  showLoading('Assigning labels to pixels...', 70);
  await new Promise(r => setTimeout(r, 50));

  // Full image labeling
  labelMap = new Uint8Array(total);
  const d2 = (a,b)=>{ const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2]; return dr*dr+dg*dg+db*db; };
  for(let i=0;i<total;i++){
    const v=[pixels[i*4],pixels[i*4+1],pixels[i*4+2]];
    let best=0, bd=Infinity;
    for(let cIdx=0;cIdx<k;cIdx++){ const dd=d2(v,centersLocal[cIdx]); if(dd<bd){bd=dd; best=cIdx;} }
    labelMap[i]=best;
  }

  // ----- Sort centers by brightness and REMAP labels accordingly -----
  const order = centersLocal.map((v,i)=>[ (v[0]+v[1]+v[2])/3, i ]).sort((a,b)=>a[0]-b[0]);
  centersLocal = order.map(([,i]) => centersLocal[i]);
  const remap = new Uint8Array(k);
  order.forEach(([,oldIdx], newIdx) => { remap[oldIdx] = newIdx; });
  for(let i=0;i<labelMap.length;i++) labelMap[i] = remap[labelMap[i]];
  labels = labels.map(l => remap[l]);

  // Persist centers globally
  window.centers = centersLocal;

  showLoading('Building UI components...', 90);
  await new Promise(r => setTimeout(r, 50));

  // Helpers
  function isLightColor([r,g,b]) {
    return (0.299*r + 0.587*g + 0.114*b) >= 186;
  }
  function withSvgBackground(svgString, bgColor = '#fff') {
    return svgString.replace(
      /<svg([^>]*)>/i,
      (m, attrs) => `<svg${attrs}><rect width="100%" height="100%" fill="${bgColor}"/>`
    );
  }

  // Swatches
  const sw = els('swatches'); 
  sw.innerHTML='';
  centersLocal.forEach(rgb=>{
    const s=document.createElement('div'); 
    s.className='sw'; 
    s.style.background=`rgb(${rgb.map(x=>x|0).join(',')})`;
    s.title = rgb2name(rgb);
    sw.appendChild(s);
  });

  // Layers list
  const layers = els('layers'); 
  layers.innerHTML='';

  // Precompute hatch parameters
  const ppi = computeUsedPPI();
  const angle = Number(els('gAngle').value);
  const spacingMM = Number(els('gSpacing').value);
  const spacingPx = (spacingMM / 25.4) * ppi;
  const strokeWidthMM = Number(els('gStrokeWidth').value);
  const strokePx = (strokeWidthMM / 25.4) * ppi;
  const xh = els('gCross').value==='Yes';
  const xha = Number(els('gCrossAngle').value);
  const bpx = getBorderPx(ppi);

    function selectedLayerIndices(){
    return centersLocal
      .map((_, idx) => ({idx, on: layersVisible[idx]}))
      .filter(o => o.on)
      .map(o => o.idx);
  }

  function renderComposite(){
    els('compositePanel').style.display = 'block';

    const ppi = computeUsedPPI();
    const strokeWidthMM = Number(els('gStrokeWidth').value);
    const strokePx = (strokeWidthMM / 25.4) * ppi;
    const bpx = getBorderPx(ppi);

    const indices = selectedLayerIndices();
    if (indices.length === 0) {
      els('compositePreview').innerHTML = `<div class="hint" style="padding:18px;">No layers selected.</div>`;
      return;
    }
    const svg = svgComposite(indices, W, H, ppi, strokePx, bpx, centersLocal);
    renderCompositeInto('compositePreview', svg);
  }

  function updateDownloadButtons(){
    const anySelected = selectedLayerIndices().length > 0;
    const zipBtn = els('downloadAll');
    const compBtn = els('downloadComposite');

    zipBtn.disabled = !anySelected;
    compBtn.disabled = !anySelected;

    // ensure they are visible now that analysis ran
    zipBtn.style.display = 'inline-block';
    compBtn.style.display = 'inline-block';
  }

  centersLocal.forEach((rgb, i)=>{
    const d=document.createElement('div'); 
    d.className='layer';
    d.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    d.innerHTML = `
      <div class="row" style="align-items:center; gap:8px; margin-bottom:6px;">
        <input type="checkbox" class="layer-toggle" data-idx="${i}" checked />
        <div style="font-weight:700; background-color:white; flex:1;">
          Layer ${i+1}: ${rgb2name(rgb)}
        </div>
        <span class="badge">#${(i+1).toString().padStart(2,'0')}</span>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="dl">Download SVG</button>
      </div>
      <div class="hint" style="margin-top:6px" data-hint></div>
    `;

    layers.appendChild(d);
        // visibility state
    if (!Array.isArray(layersVisible) || layersVisible.length !== centersLocal.length) {
      layersVisible = Array.from({length: centersLocal.length}, () => true);
    } else {
      layersVisible[i] = true;
    }

    const btn = d.querySelector('.dl');
    const toggle = d.querySelector('.layer-toggle');

    const refreshButtonState = () => {
      btn.disabled = !layersVisible[i];
      btn.classList.toggle('secondary', !layersVisible[i]);
      btn.title = layersVisible[i] ? '' : 'Enable this layer to download';
    };
    refreshButtonState();

    toggle.addEventListener('change', () => {
      layersVisible[i] = toggle.checked;
      // clear seg cache when toggling may not be strictly required, but safe if settings changed elsewhere
      // (we keep cache; toggling only affects inclusion)
      refreshButtonState();
      renderComposite(); // update composite when layer visibility changes
      updateDownloadButtons(); // enable/disable composite/all buttons
    });


    // Build mask & segments for this layer
    const mask = buildMaskForLabel(i, invert);
    const segA = buildHatchSegments(mask, W, H, angle, spacingPx);
    const segs = xh ? segA.concat(buildHatchSegments(mask, W, H, xha, spacingPx)) : segA;

    let svg = svgFromSegments(segs, W, H, ppi, strokePx, bpx, rgb);

    // Decide background by stroke lightness
    const useBlackBg = isLightColor(rgb);
    const bg = useBlackBg ? '#000' : '#fff';

    // Inject background rect into SVG
    svg = withSvgBackground(svg, bg);

    // Preview container
    const preview = document.createElement('div');
    preview.setAttribute('data-preview', '');
    preview.className = 'svg-preview';

    preview.style.width = '100%';
    preview.style.border = useBlackBg ? '1px solid #333' : '1px solid #ddd';
    preview.style.background = bg;
    preview.style.padding = '6px';
    preview.style.borderRadius = '6px';
    preview.style.marginTop = '8px';
    preview.style.overflow = 'hidden';
    preview.style.position = 'relative';

    const totalW = W + 2*(bpx||0);
    const totalH = H + 2*(bpx||0);
    preview.style.aspectRatio = `${totalW} / ${totalH}`;

    const inner = document.createElement('div');
    inner.style.width = '100%';
    inner.style.height = '100%';
    inner.style.transformOrigin = 'center center';
    inner.style.transition = 'transform 160ms ease-out';
    inner.innerHTML = svg;

    const inlineSvg = inner.querySelector('svg');
    if (inlineSvg) {
      inlineSvg.removeAttribute('width');
      inlineSvg.removeAttribute('height');
      inlineSvg.style.width = '100%';
      inlineSvg.style.height = '100%';
      inlineSvg.style.display = 'block';
    }

    preview.addEventListener('mouseenter', () => { inner.style.transform = 'scale(1.5)'; });
    preview.addEventListener('mouseleave', () => { inner.style.transform = 'scale(1)'; });

    preview.appendChild(inner);

    const row = d.querySelector('.row');
    d.insertBefore(preview, row);

    btn.addEventListener('click', ()=> {
      // Ensure downloaded SVG also has background
      downloadOne(i, withSvgBackground(svg, bg));
    });
  });

  // Enable "Download All"
  const zipBtn = els('downloadAll');
  zipBtn.style.display='inline-block';
  zipBtn.disabled=false;

  // Show & draw cluster chart
  els('chartPanel').style.display = 'block';
  drawClusterChart(sample, labels, centersLocal, k);

  els('showCentroids').addEventListener('change', () => {
    drawClusterChart(sample, labels, centersLocal, k);
  });
  els('showLabels').addEventListener('change', () => {
    drawClusterChart(sample, labels, centersLocal, k);
  });

  // 3D visualization
  els('threeDPanel').style.display = 'block';
  sampleDataFor3D = sample;
  update3DVisualization(sample, centersLocal);

  showLoading('Finalizing...', 100);
  await new Promise(r => setTimeout(r, 200));
  hideLoading();

    // Show initial composite and enable buttons
  renderComposite();
  updateDownloadButtons();

  // Download composite handler (rebuilds with current settings & selections)
  els('downloadComposite').onclick = () => {
    const ppi = computeUsedPPI();
    const strokeWidthMM = Number(els('gStrokeWidth').value);
    const strokePx = (strokeWidthMM / 25.4) * ppi;
    const bpx = getBorderPx(ppi);

    const indices = selectedLayerIndices();
    if (indices.length === 0) return;

    const svg = svgComposite(indices, W, H, ppi, strokePx, bpx, centersLocal);
    const name = `${sourceBase}--composite.svg`;
    const blob = new Blob([svg], {type:'image/svg+xml'});
    saveAs(blob, name);
  };

}


// Attach the handler
els('analyze').addEventListener('click', analyzeImage);


function buildMaskForLabel(lbl, invert){
  const m = new Uint8Array(W*H);
  for(let i=0;i<W*H;i++){ m[i] = (labelMap[i]===lbl) ? 1 : 0; }
  if(invert){ for(let i=0;i<W*H;i++) m[i]=m[i]?0:1; }
  return m;
}

// BEFORE:
// async function downloadOne(idx, dEl){
async function downloadOne(idx){
  const invert = els('invert').value==='1';
  const ppi = computeUsedPPI();
  const angle = Number(els('gAngle').value);
  const spacingMM = Number(els('gSpacing').value);
  const spacingPx = (spacingMM / 25.4) * ppi;
  const strokeWidthMM = Number(els('gStrokeWidth').value);
  const strokePx = (strokeWidthMM / 25.4) * ppi;
  const xh = els('gCross').value==='Yes';
  const xha = Number(els('gCrossAngle').value);

  const mask = buildMaskForLabel(idx, invert);
  const segA = buildHatchSegments(mask, W, H, angle, spacingPx);
  const segs = xh ? segA.concat(buildHatchSegments(mask,W,H,xha,spacingPx)) : segA;
  const bpx = getBorderPx(ppi);

  // generate fresh SVG (no need to pass it in)
  const svg = svgFromSegments(segs, W, H, ppi, strokePx, bpx, centers[idx]);

  const name = `${sourceBase}--layer-${String(idx+1).padStart(2,'0')}-${makeSlug(rgb2name(centers[idx]))}.svg`;
  const blob = new Blob([svg], {type:'image/svg+xml'});
  saveAs(blob, name);

  // update hint inside this layer card
  const layerCard = document.querySelector(`.layer[data-layer="${idx}"] [data-hint]`);
  if (layerCard) layerCard.textContent = `Exported ${name}`;
}


els('downloadAll').addEventListener('click', async ()=>{
  const ppi = computeUsedPPI();
  const angle = Number(els('gAngle').value);
  const spacingMM = Number(els('gSpacing').value);
  const spacingPx = (spacingMM / 25.4) * ppi;
  const strokeWidthMM = Number(els('gStrokeWidth').value);
  const strokePx = (strokeWidthMM / 25.4) * ppi;
  const xh = els('gCross').value==='Yes';
  const xha = Number(els('gCrossAngle').value);
  const bpx = getBorderPx(ppi);
  if(!centers) return;

  const indices = centers.map((_,i)=>i).filter(i => layersVisible[i]);
  if (indices.length === 0) return;

  const zip = new JSZip();
  for (const i of indices){
    const segs = getLayerSegments(i, angle, spacingPx, xh, xha);
    const svg = svgFromSegments(segs, W, H, ppi, strokePx, bpx, centers[i]);
    const name = `${sourceBase}--layer-${String(i+1).padStart(2,'0')}-${makeSlug(rgb2name(centers[i]))}.svg`;
    zip.file(name, svg);
  }
  const blob = await zip.generateAsync({type:'blob'});
  saveAs(blob, `${sourceBase}--layers.zip`);
});


// Image rotation functionality
let currentRotation = 0;

function rotateImage(degrees) {
  if (!img) return;
  
  currentRotation = (currentRotation + degrees) % 360;
  if (currentRotation < 0) currentRotation += 360;
  
  const previewImg = document.getElementById('preview');
  previewImg.style.transform = `rotate(${currentRotation}deg)`;
  
  // Update the actual image data for processing
  rotateImageData(degrees);
}

function rotateImageData(degrees) {
  if (!img || !pixels) return;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Swap width and height for 90/270 degree rotations
  if (degrees % 180 !== 0) {
    canvas.width = H;
    canvas.height = W;
  } else {
    canvas.width = W;
    canvas.height = H;
  }
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  
  // Translate to center and rotate
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(degrees * Math.PI / 180);
  ctx.translate(-W / 2, -H / 2);
  
  // Draw the image
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  
  // Update the global image and pixel data
  img = new Image();
  img.onload = () => {
    // Update dimensions
    if (degrees % 180 !== 0) {
      [W, H] = [H, W];
    }
    
    // Update pixel data
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = W;
    tempCanvas.height = H;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0);
    pixels = tempCtx.getImageData(0, 0, W, H).data;
    
    updateSizeUI();
  };
  img.src = canvas.toDataURL();
}

// Initialize drag and drop functionality when page loads
document.addEventListener('DOMContentLoaded', () => {
  setupDragAndDrop();
  
  // Add rotation button event listeners
  els('rotateLeft').addEventListener('click', () => rotateImage(-90));
  els('rotateRight').addEventListener('click', () => rotateImage(90));

  // Load default image (ketubah.png) on page load
  const previewImg = document.getElementById('preview');
  const dropText = document.getElementById('dropText');
  
  // Create a mock file object for the default image
  const createMockFileObject = async () => {
    try {
      const response = await fetch('ketubah.png');
      const blob = await response.blob();
      
      // Create a mock file object with the default image name
      fileObj = new File([blob], 'ketubah.png', { type: 'image/png' });
      sourceBase = 'ketubah';
      
      // Set detected PPI for the default image
      detectedPPI = await detectPPI(fileObj);
      
      // Process the default image
      const tempImg = new Image();
      tempImg.onload = () => {
        // Set the global img variable
        img = tempImg;
        W = img.naturalWidth;
        H = img.naturalHeight;
        const cvs = document.createElement('canvas');
        cvs.width = W;
        cvs.height = H;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0);
        pixels = ctx.getImageData(0, 0, W, H).data;
        updateSizeUI();
      };
      tempImg.src = 'ketubah.png';
    } catch (error) {
      console.error('Error loading default image:', error);
    }
  };
  
  // Check if the default image is already loaded
  if (previewImg.complete && previewImg.naturalHeight !== 0) {
    // Image is already loaded, hide drop text
    dropText.style.display = 'none';
    createMockFileObject();
  } else {
    // Wait for image to load
    previewImg.onload = () => {
      dropText.style.display = 'none';
      createMockFileObject();
    };
  }
});

function svgComposite(indices, W, H, ppi, strokePx, borderPx, centers) {
  const totalWpx = W + 2*(borderPx||0);
  const totalHpx = H + 2*(borderPx||0);
  const widthMM = (totalWpx/ppi)*25.4, heightMM=(totalHpx/ppi)*25.4;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMM.toFixed(3)}mm" height="${heightMM.toFixed(3)}mm" viewBox="0 0 ${totalWpx} ${totalHpx}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`
  ];

  if (borderPx>0) parts.push(`<g transform="translate(${borderPx.toFixed(2)},${borderPx.toFixed(2)})">`);

  // hatch settings
  const angle = Number(els('gAngle').value);
  const spacingMM = Number(els('gSpacing').value);
  const spacingPx = (spacingMM / 25.4) * ppi;
  const xh = els('gCross').value==='Yes';
  const xha = Number(els('gCrossAngle').value);

  indices.forEach(idx => {
    const segs = getLayerSegments(idx, angle, spacingPx, xh, xha);
    const hex = hexFromRGB(centers[idx]);

    parts.push(`<g stroke="${hex}" stroke-width="${strokePx}" stroke-linecap="round" stroke-linejoin="round" fill="none">`);
    for (const [[x1,y1],[x2,y2]] of segs) {
      parts.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    }
    parts.push(`</g>`);
  });

  if (borderPx>0) parts.push(`</g>`);
  parts.push(`</svg>`);
  return parts.join("");
}

function renderCompositeInto(containerId, svgString){
  const el = els(containerId);
  el.innerHTML = '';
  const holder = document.createElement('div');
  holder.style.width = '100%';
  holder.style.height = '100%';
  holder.innerHTML = svgString;

  const svg = holder.querySelector('svg');
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
  }
  el.appendChild(holder);
}
