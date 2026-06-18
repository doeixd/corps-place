#!/bin/bash
# 🚀 DCI Project: Automated Colab GPU Setup & Run

# 1/4 | Installing Node.js 20...
if node -v | grep -q "v20"; then
    echo -e "\x1b[32m✅ Node.js 20 already installed.\x1b[0m"
else
    echo -e "\x1b[36m1/4 | Installing Node.js 20...\x1b[0m"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
    sudo apt-get install -y nodejs > /dev/null 2>&1
fi

echo -e "\x1b[36m2/4 | Verifying GPU Environment...\x1b[0m"
nvidia-smi -L || { echo -e "\x1b[31m❌ Error: No GPU found. Did you enable T4 GPU in Notebook Settings?\x1b[0m"; exit 1; }

echo -e "\x1b[36m3/4 | Installing Dependencies (GPU Mode)...\x1b[0m"
if [ -d "node_modules/@tensorflow/tfjs-node-gpu" ]; then
    echo -e "\x1b[32m✅ TFJS-GPU already in node_modules.\x1b[0m"
else
    echo "Installing via npm..."
    npm install --quiet > /dev/null 2>&1
    npm uninstall @tensorflow/tfjs-node --quiet > /dev/null 2>&1
    npm install @tensorflow/tfjs-node-gpu --quiet > /dev/null 2>&1
fi

echo -e "\x1b[36m3.5 | Patching CUDA 11 Compatibility (for TFJS)...\x1b[0m"
# Check if core libraries are registered
if ldconfig -p | grep -q "libcudart.so.11.0" && ldconfig -p | grep -q "libcudnn.so.8"; then
    echo -e "\x1b[32m✅ CUDA 11 and cuDNN 8 libraries already found in system.\x1b[0m"
else
    echo "CUDA 11 compatibility layer missing or incomplete. Installing via pip..."
    # We install exactly what TFJS-Node-GPU 4.x (built for CUDA 11) expects
    pip install --quiet \
        nvidia-cuda-runtime-cu11 \
        nvidia-cublas-cu11 \
        nvidia-cudnn-cu11 \
        nvidia-cufft-cu11 \
        nvidia-curand-cu11 \
        nvidia-cusparse-cu11 \
        nvidia-cusolver-cu11
    
    echo "Creating surgical symlinks for TFJS compatibility..."
    # TFJS expects specific versioned files that pip-installed modules often name slightly differently
    # We will find the actual .so files and create the exactly-named symlinks in a central 'js-gpu-libs' dir
    mkdir -p /content/js-gpu-libs
    
    # Target files TFJS usually wants:
    # libcudart.so.11.0
    # libcublas.so.11
    # libcublasLt.so.11
    # libcudnn.so.8
    # libcufft.so.10
    # libcurand.so.10
    # libcusparse.so.11
    # libcusolver.so.11
    
    find /usr/local/lib/python3*/dist-packages/nvidia -name "*.so*" | while read -r libPath; do
        sourceFile=$(basename "$libPath")
        # Extract base name (e.g., libcudart)
        baseName=$(echo "$sourceFile" | cut -d. -f1)
        
        # Mapping logic
        case "$baseName" in
            libcudart)   ln -sf "$libPath" /content/js-gpu-libs/libcudart.so.11.0 ;;
            libcublas)   ln -sf "$libPath" /content/js-gpu-libs/libcublas.so.11 ;;
            libcublasLt) ln -sf "$libPath" /content/js-gpu-libs/libcublasLt.so.11 ;;
            libcudnn)    ln -sf "$libPath" /content/js-gpu-libs/libcudnn.so.8 ;;
            libcufft)    ln -sf "$libPath" /content/js-gpu-libs/libcufft.so.10 ;;
            libcurand)   ln -sf "$libPath" /content/js-gpu-libs/libcurand.so.10 ;;
            libcusparse) ln -sf "$libPath" /content/js-gpu-libs/libcusparse.so.11 ;;
            libcusolver) ln -sf "$libPath" /content/js-gpu-libs/libcusolver.so.11 ;;
        esac
    done
    
    export LD_LIBRARY_PATH=/content/js-gpu-libs:$LD_LIBRARY_PATH
    echo "Created /content/js-gpu-libs with surgical symlinks."
fi

# Standard Colab paths + extra safety
export LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:/usr/lib64-nvidia:$LD_LIBRARY_PATH
echo "Final LD_LIBRARY_PATH: $LD_LIBRARY_PATH"

# Hot-swap the import in the main training file (idempotent sed)
if grep -q "@tensorflow/tfjs-node-gpu" src/training/trainModelV9Subcaption-fixed.ts; then
    echo -e "\x1b[32m✅ Source already patched for GPU.\x1b[0m"
else
    echo "Patching source code for GPU imports..."
    find src/training -name "trainModelV9Subcaption-fixed.ts" -exec sed -i 's/@tensorflow\/tfjs-node/@tensorflow\/tfjs-node-gpu/g' {} +
fi

echo -e "\x1b[36m3.6 | Verifying TFJS GPU Integration...\x1b[0m"
# Check if we can actually see the GPU device from inside Node
node -e "
const tf = require('@tensorflow/tfjs-node-gpu');
async function verify() {
  console.log('TFJS Version:', tf.version.tfjs);
  console.log('Backend:', tf.getBackend());
  
  // Real check: does tf.node see the T4?
  if (tf.node && typeof tf.node.getGpuDevices === 'function') {
    const devices = tf.node.getGpuDevices();
    console.log('GPU Devices found:', JSON.stringify(devices));
    if (devices.length > 0) {
      console.log('🚀 SUCCESS: GPU is fully registered and accessible!');
    } else {
      console.log('⚠️ FAILURE: Backend is tensorflow but NO GPU DEVICES DETECTED.');
      console.log('Check DLERROR outputs above for missing libraries.');
    }
  } else {
    console.log('🚀 Running execution test...');
    try {
      tf.tensor([1, 2, 3]).square().print();
      console.log('✅ Basic execution test passed (check for CPU fallback messages above).');
    } catch(e) {
      console.error('❌ Execution failed:', e.message);
    }
  }
}
verify();
"

echo -e "\x1b[32m✅ Setup Complete!\x1b[0m"
echo -e "\x1b[35m4/4 | Starting Training (The Big Squeeze)...\x1b[0m"

# Saturation check: Batch 512 + Samples 8192
npx -y tsx src/training/trainModelV9Subcaption-fixed.ts --epochs 800 --samples-per-epoch 8192 --batch-size 512
