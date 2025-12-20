//
//  TicTacToeView.swift
//  MultiplayerGames
//
//  Tic-Tac-Toe game view
//

import SwiftUI

struct TicTacToeView: View {
    @StateObject private var viewModel = TicTacToeViewModel()
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
                Text("Tic-Tac-Toe")
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
                    if let state = viewModel.gameState {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                            ForEach(0..<9, id: \.self) { index in
                                CellView(
                                    value: state.board[index / 3][index % 3],
                                    isDisabled: state.winner != nil || state.isDraw || state.currentPlayer != viewModel.currentSymbol
                                ) {
                                    viewModel.makeMove(position: index)
                                }
                            }
                        }
                        .padding()
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

struct CellView: View {
    let value: String?
    let isDisabled: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(value ?? "")
                .font(.system(size: 50, weight: .bold))
                .foregroundColor(value == "X" ? .blue : (value == "O" ? .purple : .clear))
                .frame(width: 80, height: 80)
                .background(Color.gray.opacity(0.2))
                .cornerRadius(10)
        }
        .disabled(value != nil || isDisabled)
    }
}

