import Foundation
import UIKit

// Keep these observations alive independently of ActivityKit and the WebView.
private var transportObservers: [NSObjectProtocol] = []
private var transportDiagnostics: [[String: Any]] = []

@_cdecl("grove_transport_observe")
func groveTransportObserve(_ callback: @escaping @convention(c) (Bool) -> Void) {
    let install = {
        guard transportObservers.isEmpty else { return }
        transportObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in callback(false) })
        transportObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in callback(true) })
    }
    if Thread.isMainThread { install() } else { DispatchQueue.main.async(execute: install) }
}

@_cdecl("grove_transport_log")
func groveTransportLog(_ message: UnsafePointer<CChar>) {
    let stage = String(cString: message)
    NSLog("Grove transport: %@", stage)
    DispatchQueue.main.async {
        transportDiagnostics.append(["time": Date().timeIntervalSince1970, "stage": stage])
        transportDiagnostics = Array(transportDiagnostics.suffix(80))
        if let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
           let data = try? JSONSerialization.data(withJSONObject: transportDiagnostics) {
            try? data.write(to: directory.appendingPathComponent("grove-transport-diagnostics.json"), options: .atomic)
        }
    }
}
