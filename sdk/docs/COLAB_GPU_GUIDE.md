# 🚀 Google Colab Node.js GPU Training Guide

Follow these steps to run your `subcaption-fixed` model on a Tesla T4 GPU for free.

## Step 1: Prepare your workspace

Create a zip of your `sdk` directory. Ensure it includes:

- `src/training/trainModelV9Subcaption-fixed.ts`
- `dci-relational.db`
- `package.json`

## Step 2: Open Colab & Switch to GPU

1. Go to [colab.research.google.com](https://colab.research.google.com).
2. Click **Edit** -> **Notebook settings**.
3. Select **T4 GPU** under Hardware accelerator.

## Step 3: Run Setup Cell

Copy and paste this into the first cell:

```bash
# 1. Install Node.js 20
!curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
!sudo apt-get install -y nodejs

# 2. Check GPU drivers
!nvidia-smi

# 3. Create Project Directory
!mkdir -p /content/project
```

## Step 4: Upload and Unzip

Upload your `sdk.zip` to the Colab file pane, then run:

```bash
# 4. Extract
!unzip /content/sdk.zip -d /content/project
%cd /content/project

# 5. Install Dependencies with GPU Support
# We swap the normal node binary for the GPU-accelerated one
!npm install
!npm uninstall @tensorflow/tfjs-node
!npm install @tensorflow/tfjs-node-gpu
```

## Step 5: Start Training

Run this in a new cell:

```bash
# 6. Run Training
# Increased samples per epoch since GPU is faster
!npx tsx src/training/trainModelV9Subcaption-fixed.ts --epochs 800 --samples-per-epoch 8192
```

## 💡 Important Tips for Colab

- **Persistence**: Colab sessions timeout after ~1.5 hours of inactivity or 12 hours total. Use a "Keep Alive" browser extension or keep the tab active.
- **Downloading Results**: Your model will be saved in `/content/project/models/v9_subcaption_fixed`. Make sure to zip and download that folder before the session ends!
- **Speed**: You should see "Epochs" completing 5-10x faster than your local machine.

# Extract and Run Everything

!unzip -o /content/sdk-colab.zip -d /content/project
%cd /content/project
!bash scripts/colab-setup.sh
