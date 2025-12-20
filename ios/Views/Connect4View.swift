//
//  Connect4View.swift
//  MultiplayerGames
//
//  Connect 4 game view
//

import SwiftUI

struct Connect4View: View {
    @StateObject private var viewModel = Connect4ViewModel()
    @Binding var selectedGame: GameType?
    
    var body: some View {
        VStack(spacing: 20) {
            // Header
            HStack {
                Button("Back") {
                    selectedGame = nil
                    viewModel.resetGame()
                }
                Spacer()
                Text("🔴 Connect 4 🟡")
                    .font(.title)
                    .fontWeight(.bold)
                Spacer()
                Spacer() // Balance the back button
            }
            .padding(.horizontal)
            
            if !viewModel.gameFound {
                // Matchmaking
                VStack(spacing: 20) {
                    if viewModel.isSearching {
                        ProgressView()
                        Text("Searching for opponent...")
                            .foregroundColor(.secondary)
                    } else {
                        Button("Find Match") {
                            viewModel.findMatch()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Game board
                VStack(spacing: 15) {
                    // Status
                    if let state = viewModel.gameState {
                        if let winner = state.winner {
                            Text(winner == viewModel.currentSymbol ? "You Win!" : "You Lose!")
                                .font(.title2)
                                .fontWeight(.bold)
                                .foregroundColor(winner == viewModel.currentSymbol ? .green : .red)
                        } else if state.isDraw {
                            Text("Draw!")
                                .font(.title2)
                                .fontWeight(.bold)
                        } else {
                            Text(state.currentPlayer == viewModel.currentSymbol ? "Your Turn" : "Opponent's Turn")
                                .font(.title3)
                                .foregroundColor(.blue)
                        }
                    }
                    
                    // Board
                    if let state = viewModel.gameState,
                       let rows = state.rows,
                       let cols = state.cols {
                        VStack(spacing: 6) {
                            ForEach(0..<rows, id: \.self) { row in
                                HStack(spacing: 6) {
                                    ForEach(0..<cols, id: \.self) { col in
                                        Connect4CellView(
                                            value: state.board[row][col],
                                            isDisabled: state.winner != nil || state.isDraw || state.currentPlayer != viewModel.currentSymbol
                                        ) {
                                            viewModel.makeMove(column: col)
                                        }
                                    }
                                }
                            }
                        }
                        .padding()
                        .background(Color.blue.opacity(0.2))
                        .cornerRadius(15)
                    }
                }
            }
            
            if let error = viewModel.errorMessage {
                Text(error)
                    .foregroundColor(.red)
                    .padding()
            }
        }
        .padding()
    }
}

struct Connect4CellView: View {
    let value: String?
    let isDisabled: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Circle()
                .fill(cellColor)
                .frame(width: 50, height: 50)
                .overlay(
                    Circle()
                        .stroke(Color.white, lineWidth: 2)
                )
        }
        .disabled(isDisabled)
    }
    
    private var cellColor: Color {
        if value == "R" {
            return .red
        } else if value == "Y" {
            return .yellow
        } else {
            return .white
        }
    }
}

