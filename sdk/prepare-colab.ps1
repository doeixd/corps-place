# 📦 Prepare Colab Archive
# This script creates 'sdk-colab.zip' with all files needed for cloud training.

$ZipFile = "sdk-colab.zip"

# Delete old zip if it exists
if (Test-Path $ZipFile) {
    Remove-Item $ZipFile -Force
    Write-Host "🗑️ Removed old $ZipFile" -ForegroundColor Gray
}

Write-Host "📂 Gathering files for $ZipFile..." -ForegroundColor Cyan

# Define exact files/dirs needed to avoid uploading GBs of node_modules or old logs
$Includes = @(
    "src",
    "results",
    "scripts",
    "dci-relational.db",
    "package.json",
    "tsconfig.json",
    "COLAB_GPU_GUIDE.md"
)

# Create the zip
Compress-Archive -Path $Includes -DestinationPath $ZipFile -CompressionLevel Optimal

if (Test-Path $ZipFile) {
    $SizeMB = [math]::Round((Get-Item $ZipFile).Length / 1MB, 2)
    Write-Host "✅ Created $ZipFile ($SizeMB MB)" -ForegroundColor Green
    Write-Host "👉 Now upload this file to Google Colab as described in COLAB_GPU_GUIDE.md" -ForegroundColor Yellow
} else {
    Write-Host "❌ Failed to create zip file." -ForegroundColor Red
}
