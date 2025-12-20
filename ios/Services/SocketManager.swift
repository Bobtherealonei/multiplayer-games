//
//  SocketManager.swift
//  MultiplayerGames
//
//  Socket.IO connection manager
//

import Foundation
import SocketIO

class GameSocketManager: ObservableObject {
    static let shared = GameSocketManager()
    
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    
    @Published var isConnected = false
    @Published var connectionError: String?
    
    private init() {
        setupSocket()
    }
    
    private func setupSocket() {
        guard let url = URL(string: Config.serverURL) else {
            connectionError = "Invalid server URL"
            return
        }
        
        manager = SocketIO.SocketManager(socketURL: url, config: [.log(true), .compress])
        socket = manager?.defaultSocket
        
        setupEventHandlers()
    }
    
    private func setupEventHandlers() {
        socket?.on(clientEvent: .connect) { [weak self] data, ack in
            print("Socket connected")
            self?.isConnected = true
            self?.connectionError = nil
        }
        
        socket?.on(clientEvent: .disconnect) { [weak self] data, ack in
            print("Socket disconnected")
            self?.isConnected = false
        }
        
        socket?.on(clientEvent: .error) { [weak self] data, ack in
            if let error = data.first as? String {
                self?.connectionError = error
            }
        }
    }
    
    func connect() {
        socket?.connect()
    }
    
    func disconnect() {
        socket?.disconnect()
    }
    
    func emit(_ event: String, _ items: SocketData...) {
        socket?.emit(event, items)
    }
    
    func on(_ event: String, callback: @escaping ([Any], SocketAckEmitter) -> Void) {
        socket?.on(event, callback: callback)
    }
    
    func off(_ event: String) {
        socket?.off(event)
    }
}

