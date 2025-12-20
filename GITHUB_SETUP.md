# Step-by-Step: Push to GitHub

Follow these steps to push your code to GitHub.

## Step 1: Create GitHub Account (If Needed)

1. Go to [github.com](https://github.com)
2. Click "Sign up" (top right)
3. Create your account (it's free!)

## Step 2: Create a New Repository on GitHub

1. After logging in, click the **"+"** icon (top right)
2. Select **"New repository"**
3. Fill in:
   - **Repository name:** `multiplayer-games` (or any name you like)
   - **Description:** "Multiplayer Tic-Tac-Toe and Connect 4 games" (optional)
   - **Visibility:** Choose **Public** (free) or **Private** (if you have GitHub Pro)
   - **IMPORTANT:** Do NOT check:
     - ❌ Add a README file
     - ❌ Add .gitignore
     - ❌ Choose a license
   - (Leave all unchecked - we'll add files from your local project)
4. Click **"Create repository"**

## Step 3: Copy Your Repository URL

After creating the repository, GitHub will show you a page with setup instructions.

**Copy the HTTPS URL** - it looks like:
```
https://github.com/YOUR_USERNAME/multiplayer-games.git
```

Save this URL - you'll need it in the next steps!

## Step 4: Open Terminal

1. On Mac: Press `Cmd + Space`, type "Terminal", press Enter
2. Or open Terminal from Applications → Utilities → Terminal

## Step 5: Navigate to Your Project

In Terminal, type:

```bash
cd /Users/husseinmroweh/Desktop/games
```

Press Enter.

## Step 6: Initialize Git (If Not Already Done)

Check if Git is already initialized:

```bash
git status
```

**If you see:** "fatal: not a git repository"
→ Run: `git init`

**If you see:** file listings
→ Git is already initialized, skip to Step 7

## Step 7: Add All Files

Add all your project files to Git:

```bash
git add .
```

This stages all files for commit.

## Step 8: Create Your First Commit

Commit your files with a message:

```bash
git commit -m "Initial commit - multiplayer games with Tic-Tac-Toe and Connect 4"
```

## Step 9: Add GitHub as Remote

Connect your local repository to GitHub:

```bash
git remote add origin https://github.com/YOUR_USERNAME/multiplayer-games.git
```

**Replace `YOUR_USERNAME` with your actual GitHub username!**

For example, if your username is `johnsmith`, it would be:
```bash
git remote add origin https://github.com/johnsmith/multiplayer-games.git
```

## Step 10: Set Main Branch

Set your branch name to `main`:

```bash
git branch -M main
```

## Step 11: Push to GitHub

Push your code to GitHub:

```bash
git push -u origin main
```

## Step 12: Authenticate

GitHub will ask you to authenticate:

**Option A: Personal Access Token (Recommended)**
1. GitHub will prompt for username and password
2. For password, use a **Personal Access Token** (not your GitHub password)
3. To create a token:
   - Go to GitHub.com → Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Name it: "Terminal Access"
   - Select scopes: Check `repo` (all repo permissions)
   - Click "Generate token"
   - **Copy the token** (you'll only see it once!)
   - Use this token as your password when pushing

**Option B: GitHub CLI (Alternative)**
```bash
# Install GitHub CLI first, then:
gh auth login
```

## Step 13: Verify Upload

1. Go back to your GitHub repository page
2. Refresh the page (F5 or Cmd+R)
3. You should see all your files!

## Troubleshooting

### Error: "remote origin already exists"

If you see this error, remove the old remote first:

```bash
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/multiplayer-games.git
```

### Error: "Authentication failed"

- Make sure you're using a Personal Access Token, not your GitHub password
- Check that your username is correct
- Try creating a new token

### Error: "Permission denied"

- Make sure the repository name matches exactly
- Check that you have write access to the repository
- Verify your GitHub username is correct

### Error: "fatal: not a git repository"

Run this first:
```bash
git init
```

Then continue from Step 7.

## Quick Reference - All Commands at Once

If you're starting fresh, here are all commands in order:

```bash
# Navigate to project
cd /Users/husseinmroweh/Desktop/games

# Initialize Git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - multiplayer games"

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/multiplayer-games.git

# Set main branch
git branch -M main

# Push to GitHub
git push -u origin main
```

## Next Steps

Once your code is on GitHub:

1. ✅ Your code is backed up
2. ✅ You can deploy to Render.com (see RENDER_DEPLOYMENT.md)
3. ✅ You can share your code with others
4. ✅ You can collaborate with others

## Updating Your Code Later

When you make changes and want to push updates:

```bash
cd /Users/husseinmroweh/Desktop/games
git add .
git commit -m "Description of your changes"
git push
```

That's it! Your code is now on GitHub! 🎉

