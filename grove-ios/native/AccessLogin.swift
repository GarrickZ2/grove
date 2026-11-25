import Foundation
import Security
import UIKit
import WebKit

// Signing in to whatever stands in front of a server (an access proxy): its
// pages on a sheet, and the cookies the server's own host ends up with.
// `src/access.rs` decides when they are enough.

private typealias Report = @convention(c) (UnsafePointer<CChar>?) -> Void

private final class AccessLogin: NSObject, WKNavigationDelegate, WKUIDelegate, UIAdaptivePresentationControllerDelegate {
    static var current: AccessLogin?

    private let target: URL
    private let report: Report
    private let navigation = UINavigationController()
    private let web: WKWebView
    private let failure = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(target: URL, report: @escaping Report) {
        self.target = target
        self.report = report
        web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.backgroundColor = .systemBackground
        let page = UIViewController()
        page.view.backgroundColor = .systemBackground
        page.title = target.host
        page.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.cancel() })
        page.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .refresh, primaryAction: UIAction { [weak self] _ in self?.reload() })
        failure.numberOfLines = 0
        failure.textAlignment = .center
        failure.textColor = .secondaryLabel
        failure.font = .preferredFont(forTextStyle: .subheadline)
        failure.isHidden = true
        for view in [web, failure, spinner] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            page.view.addSubview(view)
        }
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: page.view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: page.view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: page.view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: page.view.trailingAnchor),
            failure.centerYAnchor.constraint(equalTo: page.view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: page.view.layoutMarginsGuide.leadingAnchor),
            failure.trailingAnchor.constraint(equalTo: page.view.layoutMarginsGuide.trailingAnchor),
            spinner.centerXAnchor.constraint(equalTo: page.view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: page.view.centerYAnchor),
        ])
        navigation.viewControllers = [page]
        navigation.presentationController?.delegate = self
    }

    func show() {
        guard let host = Self.topController() else { finish(nil); return }
        // The page's own field would bring its keyboard back over the sheet.
        host.view.window?.endEditing(true)
        host.present(navigation, animated: true)
        reload()
    }

    func dismiss(animated: Bool) {
        web.stopLoading()
        web.navigationDelegate = nil
        navigation.presentingViewController?.dismiss(animated: animated)
    }

    private func cancel() {
        dismiss(animated: true)
        finish(nil)
    }

    private func finish(_ cookie: String?) {
        if let cookie { cookie.withCString { report($0) } } else { report(nil) }
    }

    private func reload() {
        failure.isHidden = true
        web.isHidden = false
        spinner.startAnimating()
        web.load(URLRequest(url: target))
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    // Swiped away.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        web.navigationDelegate = nil
        finish(nil)
    }

    func webView(_: WKWebView, didCommit _: WKNavigation!) {
        spinner.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        guard let url = webView.url, url.host == target.host else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self, AccessLogin.current === self else { return }
            let header = cookies
                .filter { Self.applies($0, to: self.target) }
                .sorted { $0.path.count > $1.path.count }
                .map { "\($0.name)=\($0.value)" }
                .joined(separator: "; ")
            self.finish(header)
        }
    }

    /// Cookies for the whole host: one scoped to a path inside it would not
    /// reach the rest of Grove.
    private static func applies(_ cookie: HTTPCookie, to url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        let domain = cookie.domain.lowercased()
        let matches = domain.hasPrefix(".") ? (host == domain.dropFirst() || host.hasSuffix(domain)) : host == domain
        let current = cookie.expiresDate.map { $0 > Date() } ?? true
        return matches && current && cookie.path == "/" && (!cookie.isSecure || url.scheme == "https")
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        // Superseded by the next load, not a failure.
        if (error as NSError).code == NSURLErrorCancelled || (error as NSError).domain == "WebKitErrorDomain" { return }
        spinner.stopAnimating()
        web.isHidden = true
        failure.text = error.localizedDescription
        failure.isHidden = false
    }

    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if ["http", "https", "about", "data", "blob"].contains(scheme) { return decisionHandler(.allow) }
        // An authenticator app, or mail: only when the person tapped it.
        if action.navigationType == .linkActivated { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    // A provider that opens a window of its own gets this one.
    func webView(_ webView: WKWebView, createWebViewWith _: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures _: WKWindowFeatures) -> WKWebView? {
        webView.load(action.request)
        return nil
    }
}

@_cdecl("grove_access_open")
func groveAccessOpen(_ url: UnsafePointer<CChar>, _ report: @escaping @convention(c) (UnsafePointer<CChar>?) -> Void) {
    let address = String(cString: url)
    DispatchQueue.main.async {
        AccessLogin.current?.dismiss(animated: false)
        AccessLogin.current = nil
        guard let target = URL(string: address) else { report(nil); return }
        let login = AccessLogin(target: target, report: report)
        AccessLogin.current = login
        login.show()
    }
}

@_cdecl("grove_access_close")
func groveAccessClose() {
    DispatchQueue.main.async {
        AccessLogin.current?.dismiss(animated: true)
        AccessLogin.current = nil
    }
}

// Each server's session, in the Keychain of this device only.

private func sessionQuery(_ server: UnsafePointer<CChar>) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "grove.server-session",
        kSecAttrAccount as String: String(cString: server),
    ]
}

@_cdecl("grove_session_read")
func groveSessionRead(_ server: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    var query = sessionQuery(server)
    query[kSecReturnData as String] = true
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
          let data = found as? Data, let value = String(data: data, encoding: .utf8) else { return nil }
    return strdup(value)
}

@_cdecl("grove_session_free")
func groveSessionFree(_ value: UnsafeMutablePointer<CChar>) {
    free(value)
}

@_cdecl("grove_session_write")
func groveSessionWrite(_ server: UnsafePointer<CChar>, _ cookie: UnsafePointer<CChar>) {
    let query = sessionQuery(server)
    SecItemDelete(query as CFDictionary)
    let value = String(cString: cookie)
    if value.isEmpty { return }
    var item = query
    item[kSecValueData as String] = Data(value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    if status != errSecSuccess { NSLog("Grove session: Keychain refused it (%d)", status) }
}
