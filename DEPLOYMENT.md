# Deployment Guide

This guide covers how to host your multiplayer games application online.

## Quick Start Options

### Option 1: Railway (Recommended - Easiest)
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway auto-detects Node.js and deploys
6. Your app will be live at `your-app.railway.app`

**Pros:** Free tier available, auto-deploys on git push, easy setup

---

### Option 2: Render
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Click "New" → "Web Service"
4. Connect your GitHub repository
5. Settings:
   - **Build Command:** `cd server && npm install`
   - **Start Command:** `cd server && node index.js`
   - **Root Directory:** Leave empty (or set to project root)
6. Click "Create Web Service"

**Pros:** Free tier, automatic SSL, easy setup

---

### Option 3: Heroku
1. Install Heroku CLI: `brew install heroku/brew/heroku` (Mac) or download from [heroku.com](https://devcenter.heroku.com/articles/heroku-cli)
2. Login: `heroku login`
3. Create app: `heroku create your-app-name`
4. Deploy: `git push heroku main`
5. Open: `heroku open`

**Note:** Heroku removed free tier, but still good for paid hosting.

---

### Option 4: Vercel (For Static + API Routes)
1. Go to [vercel.com](https://vercel.com)
2. Import your GitHub repository
3. Configure:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Output Directory:** `../client`
4. Deploy

**Note:** Vercel works but Socket.IO may need special configuration.

---

## Pre-Deployment Checklist

### 1. Update CORS Settings (Important!)
Before deploying, update the CORS settings in `server/index.js`:

```javascript
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://your-domain.com", // Your frontend URL
    methods: ["GET", "POST"],
    credentials: true
  }
});
```

### 2. Environment Variables
Create a `.env` file (don't commit it):

```env
PORT=3000
CLIENT_URL=https://your-domain.com
NODE_ENV=production
```

### 3. Update Client Socket Connection
If your frontend is on a different domain, update the client:

```javascript
const socket = io('https://your-backend-url.com', {
  transports: ['websocket', 'polling']
});
```

---

## Deployment Steps (Railway Example)

1. **Initialize Git Repository** (if not already done):
```bash
cd /Users/husseinmroweh/Desktop/games
git init
git add .
git commit -m "Initial commit"
```

2. **Create GitHub Repository**:
   - Go to GitHub and create a new repository
   - Don't initialize with README

3. **Push to GitHub**:
```bash
git remote add origin https://github.com/yourusername/your-repo.git
git branch -M main
git push -u origin main
```

4. **Deploy on Railway**:
   - Connect GitHub repo to Railway
   - Railway will auto-detect and deploy
   - Get your URL from Railway dashboard

5. **Update Client Socket URL**:
   - In `client/ticTacToe.js` and `client/connect4.js`, update:
   ```javascript
   const socket = io('https://your-railway-url.railway.app');
   ```

---

## Alternative: Deploy Frontend Separately

You can host the frontend and backend separately:

### Frontend (Static Hosting):
- **Netlify** or **Vercel** for client files
- Update socket connection to point to your backend URL

### Backend (API):
- **Railway**, **Render**, or **Heroku** for server
- Make sure CORS allows your frontend domain

---

## Testing After Deployment

1. Visit your deployed URL
2. Open two browser windows/tabs
3. Click "Find Match" in both
4. Test that games work correctly
5. Check browser console for any errors

---

## Troubleshooting

### Socket.IO Connection Issues
- Check CORS settings match your frontend URL
- Ensure WebSocket is enabled on your hosting platform
- Check firewall/security settings

### Static Files Not Loading
- Verify the path to client directory is correct
- Check that `express.static` is pointing to the right location

### Port Issues
- Most platforms set `PORT` environment variable automatically
- Your code already handles this: `process.env.PORT || 3000`

---

## Security Recommendations

1. **Rate Limiting**: Add rate limiting to prevent abuse
2. **Input Validation**: Validate all moves on server (already done)
3. **HTTPS**: Always use HTTPS in production
4. **Environment Variables**: Never commit secrets to git

---

## Monitoring

Consider adding:
- **Logging**: Use services like Logtail or Papertrail
- **Error Tracking**: Sentry for error monitoring
- **Analytics**: Track game sessions

---

## Cost Estimates

- **Railway**: Free tier (500 hours/month), then ~$5/month
- **Render**: Free tier available, then ~$7/month
- **Heroku**: Starts at $7/month (no free tier)
- **Vercel**: Free tier for static sites

---

## Need Help?

Check platform-specific documentation:
- [Railway Docs](https://docs.railway.app)
- [Render Docs](https://render.com/docs)
- [Heroku Docs](https://devcenter.heroku.com)

