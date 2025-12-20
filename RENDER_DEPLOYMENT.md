# Deploying to Render.com - Step by Step Guide

This guide will walk you through deploying your multiplayer games server to Render.com.

## Prerequisites

1. A GitHub account
2. Your code pushed to a GitHub repository
3. A Render.com account (free signup at render.com)

## Step 1: Prepare Your Code

### 1.1 Make sure your code is ready

Your project structure should look like this:
```
games/
├── server/
│   ├── index.js
│   ├── package.json
│   ├── gameManager.js
│   ├── matchmaking.js
│   ├── ticTacToe.js
│   ├── connect4.js
│   └── game.js
├── client/
│   └── (all your client files)
└── render.yaml (optional, but helpful)
```

### 1.2 Update package.json (if needed)

Make sure your `server/package.json` has a start script:
```json
{
  "scripts": {
    "start": "node index.js"
  }
}
```

## Step 2: Push to GitHub

### 2.1 Initialize Git (if not already done)

```bash
cd /Users/husseinmroweh/Desktop/games
git init
git add .
git commit -m "Ready for Render deployment"
```

### 2.2 Create GitHub Repository

1. Go to [github.com](https://github.com)
2. Click the "+" icon → "New repository"
3. Name it: `multiplayer-games` (or any name you like)
4. **Don't** initialize with README, .gitignore, or license
5. Click "Create repository"

### 2.3 Push Your Code

```bash
git remote add origin https://github.com/YOUR_USERNAME/multiplayer-games.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

## Step 3: Deploy on Render

### 3.1 Sign Up / Log In

1. Go to [render.com](https://render.com)
2. Sign up or log in (you can use GitHub to sign in)

### 3.2 Create New Web Service

1. Click **"New +"** button in the dashboard
2. Select **"Web Service"**
3. Click **"Connect account"** if you haven't connected GitHub yet
4. Select your GitHub repository (`multiplayer-games`)

### 3.3 Configure Your Service

Fill in the following settings:

**Basic Settings:**
- **Name:** `multiplayer-games` (or any name)
- **Region:** Choose closest to you (e.g., `Oregon (US West)`)
- **Branch:** `main`
- **Root Directory:** Leave **empty** (or set to `server` if you want)

**Build & Deploy:**
- **Environment:** `Node`
- **Build Command:** `cd server && npm install`
- **Start Command:** `cd server && node index.js`

**OR if you set Root Directory to `server`:**
- **Build Command:** `npm install`
- **Start Command:** `node index.js`

### 3.4 Advanced Settings (Optional)

Click **"Advanced"** to configure:

**Environment Variables:**
- `NODE_ENV` = `production`
- `PORT` = `10000` (Render sets this automatically, but you can specify)
- `CLIENT_URL` = Leave empty for now (we'll set this later if needed)

**Health Check Path:**
- Leave empty (or set to `/`)

### 3.5 Create Service

1. Click **"Create Web Service"**
2. Render will start building and deploying your app
3. This takes 2-5 minutes

## Step 4: Get Your URL

Once deployment is complete:

1. Render will give you a URL like: `https://multiplayer-games.onrender.com`
2. **Save this URL** - you'll need it!

## Step 5: Update Client Code (If Needed)

### 5.1 For Web Clients

If your web clients are on a different domain, update the Socket.IO connection:

In `client/ticTacToe.js` and `client/connect4.js`:

```javascript
// Change from:
const socket = io();

// To:
const socket = io('https://your-app-name.onrender.com');
```

### 5.2 For iOS App

Update `ios/Config.swift`:

```swift
static let serverURL = "https://your-app-name.onrender.com"
```

## Step 6: Test Your Deployment

1. Visit your Render URL: `https://your-app-name.onrender.com`
2. You should see the game selection page
3. Open two browser tabs/windows
4. Click "Find Match" in both
5. Test that games work correctly

## Step 7: Configure CORS (If Needed)

If you're hosting the frontend separately, update `server/index.js`:

```javascript
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://your-frontend-domain.com",
    methods: ["GET", "POST"],
    credentials: true
  }
});
```

Then add environment variable in Render:
- `CLIENT_URL` = `https://your-frontend-domain.com`

## Troubleshooting

### Issue: Build Fails

**Error:** "Cannot find module"
- **Solution:** Make sure `package.json` is in the `server/` directory
- Check that all dependencies are listed in `package.json`

### Issue: App Crashes on Start

**Error:** "Port already in use" or connection errors
- **Solution:** Your code already uses `process.env.PORT || 3000`, which is correct
- Render automatically sets the PORT environment variable

### Issue: Static Files Not Loading

**Error:** 404 for CSS/JS files
- **Solution:** Check the path in `server/index.js`:
  ```javascript
  app.use(express.static('../client', { index: false }));
  ```
- Make sure the `client/` directory is in your repository

### Issue: Socket.IO Connection Fails

**Error:** "WebSocket connection failed"
- **Solution:** 
  1. Check that your Render URL is correct
  2. Make sure CORS is configured properly
  3. Render supports WebSockets by default, so this should work

### Issue: App Goes to Sleep (Free Tier)

**Problem:** Render free tier spins down after 15 minutes of inactivity
- **Solution:** 
  - First request after sleep takes ~30 seconds to wake up
  - Consider upgrading to paid plan for always-on service
  - Or use a service like UptimeRobot to ping your app every 10 minutes

## Render Free Tier Limits

- **750 hours/month** (enough for always-on if it's your only service)
- **512 MB RAM**
- **Spins down after 15 min inactivity** (wakes on first request)
- **Free SSL certificate** (HTTPS)

## Upgrading to Paid Plan

If you need:
- Always-on service (no spin-down)
- More resources
- Better performance

Upgrade to **Starter Plan** ($7/month):
- Always on
- 512 MB RAM
- Better performance

## Monitoring Your App

1. Go to your service dashboard on Render
2. Click **"Logs"** tab to see real-time logs
3. Click **"Metrics"** to see CPU, memory usage
4. Click **"Events"** to see deployment history

## Updating Your App

Every time you push to GitHub:
1. Render automatically detects the push
2. Starts a new build
3. Deploys the new version
4. Your app updates automatically!

Just do:
```bash
git add .
git commit -m "Your changes"
git push
```

## Custom Domain (Optional)

1. In Render dashboard, go to your service
2. Click **"Settings"** → **"Custom Domain"**
3. Add your domain (e.g., `games.yourdomain.com`)
4. Follow DNS configuration instructions
5. Render provides free SSL for custom domains

## Environment Variables in Render

To add/update environment variables:

1. Go to your service dashboard
2. Click **"Environment"** tab
3. Click **"Add Environment Variable"**
4. Enter key and value
5. Click **"Save Changes"**
6. Service will restart with new variables

## Next Steps

1. ✅ Your server is now live on Render
2. ✅ Test with web clients
3. ✅ Update iOS app with Render URL
4. ✅ Share your game URL with friends!

## Support

- Render Docs: https://render.com/docs
- Render Community: https://community.render.com
- Check Render status: https://status.render.com

---

**Your app URL will be:** `https://your-app-name.onrender.com`

Save this URL and update your clients to use it!

