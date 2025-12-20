//
//  ContentView.swift
//  MultiplayerGames
//
//  Main content view
//

import SwiftUI

struct ContentView: View {
    @StateObject private var socketManager = GameSocketManager.shared
    @State private var selectedGame: GameType?
    
    var body: some View {
        NavigationView {
            if socketManager.isConnected {
                if let game = selectedGame {
                    gameView(for: game)
                } else {
                    GameSelectionView(selectedGame: $selectedGame)
                }
            } else {
                VStack(spacing: 20) {
                    Text("Connecting to server...")
                        .font(.title2)
                    
                    if let error = socketManager.connectionError {
                        Text(error)
                            .foregroundColor(.red)
                    }
                    
                    Button("Retry") {
                        socketManager.connect()
                    }
                }
                .onAppear {
                    socketManager.connect()
                }
            }
        }
    }
    
    @ViewBuilder
    private func gameView(for game: GameType) -> some View {
        switch game {
        case .ticTacToe:
            TicTacToeView(selectedGame: $selectedGame)
        case .connect4:
            Connect4View(selectedGame: $selectedGame)
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}

