#!/bin/bash
set -e

PROJECT_ROOT="/home/ange/Dev/Antigravity/clawui"
SERVICE_DIR="$HOME/.config/systemd/user"

echo "Building projects..."
cd "$PROJECT_ROOT"
npm run build

echo "Setting up systemd services..."
mkdir -p "$SERVICE_DIR"
cp "$PROJECT_ROOT/clawui-backend.service" "$SERVICE_DIR/"
cp "$PROJECT_ROOT/clawui-frontend.service" "$SERVICE_DIR/"

echo "Reloading systemd daemon..."
systemctl --user daemon-reload

echo "Enabling and starting services..."
systemctl --user enable clawui-backend.service
systemctl --user enable clawui-frontend.service
systemctl --user restart clawui-backend.service
systemctl --user restart clawui-frontend.service

# Ensure services stay running after logout
echo "Enabling lingering for user $(whoami)..."
sudo loginctl enable-linger $(whoami)

echo "------------------------------------------------"
echo "Deployment complete!"
echo "Dev:     Backend: http://localhost:3100, Frontend: http://localhost:3105"
echo "Release: Backend: http://localhost:3110, Frontend: http://localhost:3115"
echo "------------------------------------------------"
echo "Check status with: systemctl --user status clawui-backend clawui-frontend"
