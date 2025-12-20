//
//  GameSelectionView.swift
//  MultiplayerGames
//
//  Game selection screen
//

import SwiftUI

struct GameSelectionView: View {
    @Binding var selectedGame: GameType?
    
    var body: some View {
        VStack(spacing: 30) {
            Text("Multiplayer Games")
                .font(.largeTitle)
                .fontWeight(.bold)
                .padding(.top, 40)
            
            Text("Choose a game to play")
                .font(.title3)
                .foregroundColor(.secondary)
            
            Spacer()
            
            VStack(spacing: 20) {
                GameCard(
                    title: "Tic-Tac-Toe",
                    description: "Classic 3x3 grid game",
                    color: .blue
                ) {
                    selectedGame = .ticTacToe
                }
                
                GameCard(
                    title: "Connect 4",
                    description: "Drop pieces and connect four",
                    color: .purple
                ) {
                    selectedGame = .connect4
                }
            }
            .padding(.horizontal, 20)
            
            Spacer()
        }
    }
}

struct GameCard: View {
    let title: String
    let description: String
    let color: Color
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                
                Text(description)
                    .font(.body)
                    .foregroundColor(.white.opacity(0.9))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(30)
            .background(
                LinearGradient(
                    gradient: Gradient(colors: [color, color.opacity(0.7)]),
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .cornerRadius(15)
            .shadow(color: color.opacity(0.3), radius: 10, x: 0, y: 5)
        }
        .buttonStyle(PlainButtonStyle())
    }
}

