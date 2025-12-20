//
//  TicTacToeViewModel.swift
//  MultiplayerGames
//
//  Tic-Tac-Toe game view model
//

import Foundation
import Combine

class TicTacToeViewModel: ObservableObject {
    @Published var gameState: GameState?
    @Published var currentSymbol: String?
    @Published var isSearching = false
    @Published var gameFound = false
    @Published var errorMessage: String?
    
    private let socketManager = GameSocketManager.shared
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        setupSocketListeners()
    }
    
    private func setupSocketListeners() {
        // Matchmaking status
        socketManager.on("matchmakingStatus") { [weak self] data, ack in
            if let dict = data[0] as? [String: Any],
               let status = dict["status"] as? String {
                DispatchQueue.main.async {
                    if status == "searching" {
                        self?.isSearching = true
                    }
                }
            }
        }
        
        // Game found
        socketManager.on("gameFound") { [weak self] data, ack in
            if let dict = data[0] as? [String: Any],
               let gameId = dict["gameId"] as? String,
               let symbol = dict["symbol"] as? String {
                DispatchQueue.main.async {
                    self?.currentSymbol = symbol
                    self?.gameFound = true
                    self?.isSearching = false
                }
            }
        }
        
        // Game state update
        socketManager.on("gameState") { [weak self] data, ack in
            if let dict = data[0] as? [String: Any] {
                do {
                    let jsonData = try JSONSerialization.data(withJSONObject: dict)
                    let state = try JSONDecoder().decode(GameState.self, from: jsonData)
                    DispatchQueue.main.async {
                        self?.gameState = state
                    }
                } catch {
                    print("Error decoding game state: \(error)")
                }
            }
        }
        
        // Move error
        socketManager.on("moveError") { [weak self] data, ack in
            if let dict = data[0] as? [String: Any],
               let error = dict["error"] as? String {
                DispatchQueue.main.async {
                    self?.errorMessage = error
                }
            }
        }
        
        // Opponent disconnected
        socketManager.on("opponentDisconnected") { [weak self] data, ack in
            DispatchQueue.main.async {
                self?.errorMessage = "Opponent disconnected"
                self?.resetGame()
            }
        }
    }
    
    func findMatch() {
        socketManager.emit("findMatch", ["gameType": "ticTacToe"])
        isSearching = true
    }
    
    func makeMove(position: Int) {
        guard let state = gameState,
              state.currentPlayer == currentSymbol,
              state.winner == nil,
              !state.isDraw else {
            return
        }
        
        socketManager.emit("makeMove", ["position": position])
    }
    
    func resetGame() {
        gameState = nil
        currentSymbol = nil
        gameFound = false
        isSearching = false
        errorMessage = nil
    }
}

