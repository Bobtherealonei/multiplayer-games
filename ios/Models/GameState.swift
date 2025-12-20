//
//  GameState.swift
//  MultiplayerGames
//
//  Game state models
//

import Foundation

struct GameState: Codable {
    let board: [[String?]]
    let currentPlayer: String
    let winner: String?
    let isDraw: Bool
    let player1Symbol: String
    let player2Symbol: String
    let rows: Int?
    let cols: Int?
    let gameType: String?
}

struct GameFound: Codable {
    let gameId: String
    let symbol: String
    let opponent: String
    let rows: Int?
    let cols: Int?
    let gameType: String?
}

struct MatchmakingStatus: Codable {
    let status: String
    let gameType: String?
    let error: String?
}

enum GameType: String, CaseIterable {
    case ticTacToe = "ticTacToe"
    case connect4 = "connect4"
    
    var displayName: String {
        switch self {
        case .ticTacToe: return "Tic-Tac-Toe"
        case .connect4: return "Connect 4"
        }
    }
}

