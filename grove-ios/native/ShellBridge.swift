import Foundation
import UIKit
import WebKit
import CoreMotion

// Native facts the web client cannot read on its own, pushed into the page:
//
// - `window.__GROVE_FOLD__`: iPhone Duo's hinge (UIHingeInteraction, iOS 27.1+),
//   as { posture, at, gap }, then a `grove:fold` event. Safari only offers
//   this behind feature flags and a second late; here it follows the hinge.
// - `window.__GROVE_DUO__`: true on a device with a hinge, so the page can use
//   the column iPhone Duo keeps beside its screens.
//
// The web view is also made full bleed, so the page lays itself out around
// the safe area with env(safe-area-inset-*), like the installed web app does.
//
// The keyboard: WebKit would pan the whole page up and add its ∧ ∨ ✓ form
// bar. Here the page stays put, the bar is gone, and the keyboard's height
// over the web view goes to `window.__GROVE_KEYBOARD__` + `grove:keyboard`,
// so the Composer can sit right on it.

private final class ShellBridge: NSObject {
    static let shared = ShellBridge()

    private weak var webView: WKWebView?
    private var observations: [NSKeyValueObservation] = []
    private var hingeStatus: Int = 0  // UIHinge.Status raw value; 0 = unknown / no hinge
    private var hingeAngle: CGFloat = 0  // radians; 0 closed, π flat
    private var hasHinge = false
    private var lastScript = ""
    private var keyboardHeight: CGFloat = 0
    /// In the tent the outer screen stands on its long edge, but the app
    /// may not rotate (rotation lock, or iOS keeping it upright): gravity
    /// says which way is down, so the page can turn its board itself.
    private let motion = CMMotionManager()
    private var tentTurn = 0

    /// 20°: a phone resting closed reads near 0; a tent stands well above it.
    private static let tentMinAngle: CGFloat = 20 * .pi / 180

    func install() {
        attach(attempt: 0)
    }

    private func attach(attempt: Int) {
        guard let web = Self.findWebView() else {
            // Tauri creates the web view during setup; wait for it, briefly.
            if attempt < 100 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.attach(attempt: attempt + 1) }
            }
            return
        }
        webView = web
        web.scrollView.contentInsetAdjustmentBehavior = .never
        Self.dropFormAccessory(web)
        installKeyboardProbe(on: web)
        installSafeAreaProbe(on: web)
        // WebKit scrolls the page to reveal a focused field; the page
        // places the Composer itself, so keep the page where it is.
        observations.append(web.scrollView.observe(\.contentOffset, options: [.new]) { scroll, _ in
            if scroll.contentOffset != .zero { scroll.contentOffset = .zero }
        })
        if #available(iOS 27.1, *) {
            let interaction = UIHingeInteraction { [weak self] _, update in
                guard let self else { return }
                self.hasHinge = update.hinge != nil
                self.hingeStatus = update.hinge?.status.rawValue ?? 0
                self.hingeAngle = update.hinge?.angle ?? 0
                self.push()
            }
            web.addInteraction(interaction)
        }
        // Rotation and the outer/inner screen swap change the bounds; a page
        // load loses what was pushed before it.
        observations.append(web.observe(\.bounds, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.push(); self?.refreshSafeArea() }
        })
        observations.append(web.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            if !web.isLoading { DispatchQueue.main.async { self?.lastScript = ""; self?.push(); self?.refreshSafeArea() } }
        })
        push()
    }

    /// Launched straight into a pose, the system can settle the safe area
    /// after the page has loaded, and WebKit keeps reading 0. A view in the
    /// same place hears every change and has WebKit take the insets again.
    private func installSafeAreaProbe(on web: WKWebView) {
        guard let host = web.superview else { return }
        let probe = SafeAreaProbe(frame: host.bounds)
        probe.isUserInteractionEnabled = false
        probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.insertSubview(probe, at: 0)
        probe.onChange = { [weak self] in self?.refreshSafeArea() }
    }

    /// The keyboard's visible top comes from the keyboard layout guide: the
    /// frame in keyboard notifications counts room for bars that no longer show.
    private func installKeyboardProbe(on web: WKWebView) {
        guard let host = web.superview else { return }
        let probe = KeyboardProbe()
        probe.isUserInteractionEnabled = false
        probe.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(probe)
        host.keyboardLayoutGuide.followsUndockedKeyboard = true
        if #available(iOS 17.0, *) { host.keyboardLayoutGuide.usesBottomSafeArea = false }
        NSLayoutConstraint.activate([
            probe.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            probe.widthAnchor.constraint(equalToConstant: 1),
            probe.heightAnchor.constraint(equalToConstant: 1),
            probe.bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor),
        ])
        probe.onMove = { [weak self, weak probe] in
            guard let self, let probe, let web = self.webView else { return }
            let top = web.convert(CGPoint(x: 0, y: probe.frame.maxY), from: probe.superview).y
            self.keyboardMoved(to: top)
            // The keys' view settles after the guide; read it again then.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self, weak probe] in
                guard let self, let probe, let web = self.webView else { return }
                self.keyboardMoved(to: web.convert(CGPoint(x: 0, y: probe.frame.maxY), from: probe.superview).y)
            }
        }
    }

    private func keyboardMoved(to guideTop: CGFloat) {
        guard let web = webView else { return }
        // The guide also counts room iOS keeps above the keys for a floating
        // bar that isn't shown here; the keys' own view says where they start.
        var top = guideTop
        if guideTop < web.bounds.maxY - 1, let keys = Self.visibleKeyboardTop() {
            // The keyboard's backdrop starts a little above its first row.
            top = max(guideTop, web.convert(CGPoint(x: 0, y: keys - 12), from: nil).y)
        }
        let height = max(0, web.bounds.maxY - top)
        web.scrollView.contentInset = .zero
        guard abs(height - keyboardHeight) > 0.5 else { return }
        keyboardHeight = height
        web.evaluateJavaScript(
            "window.__GROVE_KEYBOARD__=\(Int(height.rounded()));window.dispatchEvent(new Event('grove:keyboard'));",
            completionHandler: nil)
    }

    /// Top of the keyboard's keys in window coordinates, from the text-effects window.
    private static func visibleKeyboardTop() -> CGFloat? {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows where String(describing: type(of: window)).contains("TextEffects") {
                if let keys = find(named: "UIKeyboardItemContainerView", in: window) ?? find(named: "_UIRemoteKeyboardPlaceholderView", in: window) {
                    let frame = keys.convert(keys.bounds, to: nil)
                    if frame.height > 0 { return frame.minY }
                }
            }
        }
        return nil
    }

    private static func find(named name: String, in view: UIView, depth: Int = 0) -> UIView? {
        if String(describing: type(of: view)) == name { return view }
        guard depth < 8 else { return nil }
        for child in view.subviews {
            if let found = find(named: name, in: child, depth: depth + 1) { return found }
        }
        return nil
    }

    /// WKWebView's form bar (previous / next / done) has no switch, so the
    /// view that offers it gets a subclass that offers none.
    private static func dropFormAccessory(_ web: WKWebView) {
        guard let content = web.scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else { return }
        let base: AnyClass = type(of: content)
        let name = "\(NSStringFromClass(base))_GroveNoAccessory"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let selector = #selector(getter: UIResponder.inputAccessoryView)
            if let method = class_getInstanceMethod(UIResponder.self, selector) {
                class_addMethod(made, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
        // On a wide screen the bar is the keyboard's assistant row; empty, it takes no room.
        content.inputAssistantItem.leadingBarButtonGroups = []
        content.inputAssistantItem.trailingBarButtonGroups = []
    }

    /// A rotation that lands while a page is loading can leave the page's
    /// env(safe-area-inset-*) at the old orientation's values. Once things
    /// settle, make WebKit take the insets again.
    private var safeAreaWork: DispatchWorkItem?
    private var nudging = false
    private func refreshSafeArea() {
        if nudging { return }
        safeAreaWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let web = self?.webView else { return }
            web.scrollView.contentInsetAdjustmentBehavior = .automatic
            web.scrollView.contentInsetAdjustmentBehavior = .never
            // WebKit reads the insets again only when its frame changes (as on
            // a rotation): change it by a point and put it back.
            // The nudge's own bounds changes must not schedule another one.
            self?.nudging = true
            let frame = web.frame
            web.frame = frame.insetBy(dx: 0, dy: 0.5)
            web.layoutIfNeeded()
            web.frame = frame
            web.setNeedsLayout()
            web.layoutIfNeeded()
            DispatchQueue.main.async { self?.nudging = false }
        }
        safeAreaWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func push() {
        guard let web = webView, hasHinge else { return }
        let size = web.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let screen = web.window?.windowScene?.screen.bounds.size ?? size
        let inner = max(screen.width, screen.height) > 800
        let partiallyOpen = hingeStatus == 2  // UIHinge.Status.partiallyOpen

        var posture = "flat"
        var at: CGFloat = 0
        if partiallyOpen && inner {
            if size.width > size.height {
                posture = "book"
                at = (size.width / 2).rounded()
            } else {
                posture = "laptop"
                at = (size.height / 2).rounded()
            }
        } else if !inner && hingeAngle > Self.tentMinAngle {
            // Opened a little with the outer screen still lit: stood on a table
            // like a tent. iOS reports such a small angle as closed, so go by it.
            posture = "tent"
        }
        if posture == "tent" { watchGravity() } else { stopGravity() }
        let turn = posture == "tent" && size.height > size.width ? tentTurn : 0
        let fold = "{\"posture\":\"\(posture)\",\"at\":\(Int(at)),\"gap\":0,\"turn\":\(turn)}"
        let script = "window.__GROVE_DUO__=true;window.__GROVE_FOLD__=\(fold);window.dispatchEvent(new Event('grove:fold'));"
        guard script != lastScript else { return }
        lastScript = script
        web.evaluateJavaScript(script, completionHandler: nil)
    }

    private func watchGravity() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 0.2
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let gravity = data?.gravity else { return }
            // x > 0: the screen's right edge points down, so its content turns
            // a quarter counter-clockwise to stand upright.
            let turn = gravity.x > 0.5 ? -90 : gravity.x < -0.5 ? 90 : self.tentTurn
            if turn != self.tentTurn { self.tentTurn = turn; self.push() }
        }
    }

    private func stopGravity() {
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
    }

    private static func findWebView() -> WKWebView? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let web = find(in: window) { return web }
            }
        }
        return nil
    }

    private static func find(in view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        for child in view.subviews {
            if let web = find(in: child) { return web }
        }
        return nil
    }
}

/// Sits on top of the keyboard layout guide and reports each move.
private final class KeyboardProbe: UIView {
    var onMove: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onMove?()
    }
    override var frame: CGRect {
        didSet { if frame != oldValue { onMove?() } }
    }
    override var center: CGPoint {
        didSet { if center != oldValue { onMove?() } }
    }
}

private final class SafeAreaProbe: UIView {
    var onChange: (() -> Void)?
    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        onChange?()
    }
}

@_cdecl("grove_shell_install")
func groveShellInstall() {
    if Thread.isMainThread {
        ShellBridge.shared.install()
    } else {
        DispatchQueue.main.async { ShellBridge.shared.install() }
    }
}
