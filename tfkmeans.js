/*
 * Fast K‑Means in the browser using TensorFlow.js (WebGL/WebGPU/WASM backends)
 * -----------------------------------------------------------
 * Drop this <script> before your app code (pick ONE backend or let tfjs choose):
 *
 * Notes:
 * - This implements k-means++ seeding and vectorized E‑steps/M‑steps.
 * - Uses one‑hot + matMul to compute cluster sums in a single pass.
 * - Memory is managed with tf.tidy; but you should still call tf.dispose() if you create extra tensors.
 */

async function tfKMeans(sampleRGB, k, opts = {}){
  const iters = opts.iters ?? 15;
  const tol = opts.tolerance ?? 1e-3; // in RGB units (0..255)
  const seed = opts.seed ?? null;
  if(seed != null) tf.util.setSeed(seed);

  // Convert to tensor [n,3] float32
  const X = tf.tensor2d(sampleRGB, [sampleRGB.length, 3], 'float32');
  const N = X.shape[0];
  if (N === 0) throw new Error('Empty sample');

  // --- k-means++ init (CPU-assisted for probability sampling) ---
  // pick first center randomly
  let centers = [];
  const firstIdx = Math.floor(Math.random() * N);
  centers.push(await X.slice([firstIdx, 0], [1, 3]).array());
  centers[0] = centers[0][0];

  while (centers.length < k){
    const C = tf.tensor2d(centers, [centers.length, 3]);
    const d2 = tf.tidy(() => {
      // squared distances to current centers: [N, lenC]
      const X2 = tf.sum(tf.mul(X, X), 1).reshape([N, 1]);
      const C2 = tf.sum(tf.mul(C, C), 1).reshape([1, C.shape[0]]);
      const XC = tf.matMul(X, C.transpose()); // [N, lenC]
      // dist^2 = ||x||^2 - 2 x·c + ||c||^2
      const D = tf.add(tf.sub(X2, tf.mul(2, XC)), C2);
      return tf.min(D, 1); // [N]
    });
    // sample next center with prob ∝ d^2
    const probs = await d2.array();
    d2.dispose();
    let sum = 0; for (let v of probs) sum += (v>0 ? v : 1e-12);
    let r = Math.random() * sum;
    let idx = 0; for (; idx < probs.length; idx++){ r -= (probs[idx] > 0 ? probs[idx] : 1e-12); if (r <= 0) break; }
    idx = Math.min(idx, probs.length - 1);
    const c = await X.slice([idx, 0], [1, 3]).array();
    centers.push(c[0]);
    C.dispose();
  }

  let C = tf.tensor2d(centers, [k, 3]);

  // --- Lloyd iterations ---
  for(let t = 0; t < iters; t++){
    // E‑step: assign labels to nearest centers
    const labels = tf.tidy(() => {
      const X2 = tf.sum(tf.mul(X, X), 1).reshape([N, 1]);
      const C2 = tf.sum(tf.mul(C, C), 1).reshape([1, k]);
      const XC = tf.matMul(X, C.transpose());
      const D = tf.add(tf.sub(X2, tf.mul(2, XC)), C2); // [N,k]
      return tf.argMin(D, 1); // [N]
    });

    // M‑step: recompute centers via one‑hot @ X
    const oneHot = tf.oneHot(labels, k).toFloat(); // [N,k]
    const sums = tf.matMul(oneHot.transpose(), X);   // [k,3]
    const counts = tf.sum(oneHot, 0).reshape([k, 1]); // [k,1]
    const newC = tf.divNoNan(sums, counts);          // [k,3]

    // Early stop check: max center shift
    const shift = tf.max(tf.sqrt(tf.sum(tf.square(tf.sub(newC, C)), 1))); // [k] -> max
    const maxShift = (await shift.array());

    C.dispose(); labels.dispose(); oneHot.dispose(); sums.dispose(); counts.dispose(); shift.dispose();
    C = newC;
    if (maxShift <= tol) break;
  }

  const centersArr = await C.array();

  // Optional: labels for the *sample* only (useful for your cluster chart)
  const labelsSample = await tf.tidy(() => {
    const X2 = tf.sum(tf.mul(X, X), 1).reshape([N, 1]);
    const C2 = tf.sum(tf.mul(C, C), 1).reshape([1, k]);
    const XC = tf.matMul(X, C.transpose());
    const D = tf.add(tf.sub(X2, tf.mul(2, XC)), C2);
    return tf.argMin(D, 1);
  }).data();

  X.dispose(); C.dispose();
  return { centers: centersArr, labelsSample: Int32Array.from(labelsSample) };
}

/* ---------------- Integration snippet ----------------
// 1) Load tfjs once near the top of your HTML (pick a backend):
// <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.min.js"></script>
// <script>tf.setBackend('webgl');</script>

// 2) Replace your current kmeans() call inside the Analyze handler:
//    const { centers: c, labelsSample } = await tfKMeans(sample, k, { iters: 15, tolerance: 0.5 });
//    centers = c; // keep using your existing brightness‑sort + remap code
//    drawClusterChart(sample, labelsSample, centers, k);
//    // For labelMap on the full image, keep your existing per‑pixel nearest‑center loop.

// 3) Optional speed tips:
//    - Use tf.setBackend('wasm') on low‑end GPUs; WASM can outperform WebGL for big N.
//    - Consider running tfKMeans on a 100k‑200k shuffled sample, then assign full image.
//    - Down‑quantize RGB to 6‑bit per channel before k‑means to remove noise & speed up.
*/
