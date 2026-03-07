#!/bin/bash
set -e

# Configuration
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SERVICE_DIR="$HOME/.config/systemd/user"

# Default Port
CLAWUI_PORT=${1:-3115}

echo "Deploying OpenClaw Chat Gateway (Consolidated)..."
echo "Project Path:  $PROJECT_ROOT"
echo "Service Port:  $CLAWUI_PORT"

echo "Installing dependencies..."
cd "$PROJECT_ROOT"
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

echo "Building projects..."
npm run build

echo "Setting up systemd service..."
mkdir -p "$SERVICE_DIR"

# Clean up old services if they exist
systemctl --user stop clawui-backend.service clawui-frontend.service 2>/dev/null || true
systemctl --user disable clawui-backend.service clawui-frontend.service 2>/dev/null || true
rm -f "$SERVICE_DIR/clawui-backend.service" "$SERVICE_DIR/clawui-frontend.service"

# Copy and update the consolidated service file
cp "$PROJECT_ROOT/clawui.service" "$SERVICE_DIR/"

# Update WorkingDirectory and Port in the service file
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_ROOT/backend|" "$SERVICE_DIR/clawui.service"
sed -i "s/Environment=PORT=.*/Environment=PORT=$CLAWUI_PORT/" "$SERVICE_DIR/clawui.service"

echo "Reloading systemd daemon..."
systemctl --user daemon-reload

echo "Enabling and starting service..."
systemctl --user enable clawui.service
systemctl --user restart clawui.service

# Ensure services stay running after logout
echo "Enabling lingering for user $(whoami)..."
if command -v loginctl >/dev/null 2>&1; then
    sudo loginctl enable-linger $(whoami) || echo "Warning: Could not enable lingering. Manual action may be required: sudo loginctl enable-linger $(whoami)"
fi

echo "------------------------------------------------"
echo "Deployment complete!"
echo "ClawUI URL: http://localhost:$CLAWUI_PORT"
echo "------------------------------------------------"
echo "Check status with: systemctl --user status clawui"
