# iOS App Development Guide

This guide will help you convert your multiplayer games into a native iOS app using Xcode and Swift.

## Overview

You'll create a native iOS app that connects to your existing Node.js server. The server stays the same - you just need to build the iOS client.

## Architecture

```
iOS App (Swift/SwiftUI) 
    ↓ Socket.IO
Node.js Server (unchanged)
```

## Step 1: Setup Xcode Project

1. Open Xcode
2. Create New Project → iOS → App
3. Name: "MultiplayerGames"
4. Interface: SwiftUI
5. Language: Swift
6. Save the project

## Step 2: Add Socket.IO Dependency

### Using Swift Package Manager (Recommended)

1. In Xcode, go to **File → Add Packages...**
2. Enter: `https://github.com/socketio/socket.io-client-swift`
3. Click "Add Package"
4. Select "SocketIO" library
5. Click "Add Package"

### Alternative: CocoaPods

Add to `Podfile`:
```ruby
pod 'Socket.IO-Client-Swift'
```

## Step 3: Project Structure

Create these files in your Xcode project:

```
MultiplayerGames/
├── Models/
│   ├── GameState.swift
│   ├── Player.swift
│   └── GameType.swift
├── Services/
│   ├── SocketManager.swift
│   └── GameService.swift
├── Views/
│   ├── ContentView.swift
│   ├── GameSelectionView.swift
│   ├── MatchmakingView.swift
│   ├── TicTacToeView.swift
│   └── Connect4View.swift
└── ViewModels/
    ├── TicTacToeViewModel.swift
    └── Connect4ViewModel.swift
```

## Step 4: Configure Info.plist

Add to `Info.plist` to allow network connections:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

Or for production, allow specific domains only.

## Step 5: Server URL Configuration

Create a `Config.swift` file:

```swift
struct Config {
    static let serverURL = "http://localhost:3000" // Change to your deployed URL
    // For production: "https://your-app.railway.app"
}
```

## Next Steps

See the code files in the `ios/` directory for complete implementation examples.

