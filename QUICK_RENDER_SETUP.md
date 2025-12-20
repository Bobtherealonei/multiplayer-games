# Quick Render.com Setup (5 Minutes)

## Fastest Way to Deploy

### 1. Push to GitHub (2 min)

```bash
cd /Users/husseinmroweh/Desktop/games
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Deploy on Render (3 min)

1. Go to [render.com](https://render.com) → Sign up/Login
2. Click **"New +"** → **"Web Service"**
3. Connect GitHub → Select your repo
4. Settings:
   - **Name:** `multiplayer-games`
   - **Build Command:** `cd server && npm install`
   - **Start Command:** `cd server && node index.js`
5. Click **"Create Web Service"**
6. Wait 2-3 minutes for deployment
7. **Copy your URL:** `https://your-app.onrender.com`

### 3. Test It

Visit your URL in browser - you should see the game selection page!

### 4. Update Clients (If Needed)

If your web clients are separate, update Socket.IO connection:

```javascript
const socket = io('https://your-app.onrender.com');
```

For iOS app, update `Config.swift`:
```swift
static let serverURL = "https://your-app.onrender.com"
```

## Done! 🎉

Your server is now live. See `RENDER_DEPLOYMENT.md` for detailed instructions.

