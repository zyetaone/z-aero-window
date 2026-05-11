#!/bin/bash
# Fix node_modules/.bin permissions for WSL
# Run this after npm/bun install if you get permission errors

echo "🔧 Fixing node_modules permissions..."

if [ ! -d "node_modules/.bin" ]; then
    echo "❌ node_modules/.bin not found. Have you run npm/bun install?"
    exit 1
fi

chmod +x node_modules/.bin/* 2>/dev/null

if [ $? -eq 0 ]; then
    echo "✅ Fixed! node_modules/.bin/* now executable"
    echo ""
    echo "You can now run:"
    echo "  npm run dev"
    echo "  bun run dev"
    echo "  npm run build"
else
    echo "⚠️  No files to fix or error occurred"
fi
