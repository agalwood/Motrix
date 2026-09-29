import Foundation

/// A resolver receives only a validated bootstrap request, without a claimed identity.
public struct BootstrapIPCRequest: Sendable, Equatable {
    public let bindingPublicKey: String
    public let allowLaunch: Bool

    public init(data: Data) throws {
        let object = try BootstrapIPCCodec.object(data, response: false)
        guard Set(object.keys) == ["action", "protocolVersion", "bindingPub", "allowLaunch"],
              object["action"] as? String == "bootstrap",
              BootstrapIPCCodec.integer(object["protocolVersion"], in: 1...1),
              let key = object["bindingPub"] as? String,
              BootstrapIPCCodec.isCanonicalKey(key),
              let launch = object["allowLaunch"] as? NSNumber,
              CFGetTypeID(launch) == CFBooleanGetTypeID()
        else { throw BootstrapIPCError.invalidRequest }
        bindingPublicKey = key
        allowLaunch = launch.boolValue
    }
}

/// The service and client independently enforce the same bounded wire contract.
enum BootstrapIPCCodec {
    static let maximumMessageBytes = 16 * 1024
    static let unavailable = Data("{\"error\":\"bootstrap-unavailable\",\"protocolVersion\":1}".utf8)
    static let invalidRequest = Data("{\"error\":\"invalid-request\",\"protocolVersion\":1}".utf8)
    static let timeout = Data("{\"error\":\"ipc-timeout\",\"protocolVersion\":1}".utf8)
    static let invalidResponse = Data("{\"error\":\"invalid-response\",\"protocolVersion\":1}".utf8)

    static func validateResponse(_ data: Data, for request: BootstrapIPCRequest) throws {
        let object = try object(data, response: true)
        if Set(object.keys) == ["error", "protocolVersion"] {
            guard integer(object["protocolVersion"], in: 1...1),
                  let error = object["error"] as? String,
                  ["bootstrap-unavailable", "invalid-request", "message-too-large", "ipc-timeout",
                   "ipc-unavailable", "invalid-response", "launch-denied"].contains(error)
            else { throw BootstrapIPCError.invalidResponse }
            return
        }
        let required: Set<String> = ["action", "protocolVersion", "port", "nonce"]
        guard Set(object.keys) == required || Set(object.keys) == required.union(["nmTicket"]),
              object["action"] as? String == "requestPair",
              integer(object["protocolVersion"], in: 1...1),
              integer(object["port"], in: 1...65535),
              object["nonce"] is NSNull || boundedASCII(object["nonce"], maximum: 512)
        else { throw BootstrapIPCError.invalidResponse }
        if let ticket = object["nmTicket"] {
            guard let ticket = ticket as? [String: Any],
                  Set(ticket.keys) == ["v", "purpose", "protocolVersion", "serverGeneration", "browser",
                                       "callerId", "exp", "bindingPub", "mac"],
                  integer(ticket["v"], in: 1...1),
                  ticket["purpose"] as? String == "mbp1-attestation",
                  integer(ticket["protocolVersion"], in: 1...1),
                  boundedASCII(ticket["serverGeneration"], maximum: 256),
                  ticket["browser"] as? String == "safari",
                  boundedASCII(ticket["callerId"], maximum: 255),
                  integer(ticket["exp"], in: 0...9007199254740991),
                  ticket["bindingPub"] as? String == request.bindingPublicKey,
                  let mac = ticket["mac"] as? String, isCanonicalKey(mac)
            else { throw BootstrapIPCError.invalidResponse }
        }
    }

    static func object(_ data: Data, response: Bool) throws -> [String: Any] {
        guard data.count <= maximumMessageBytes else { throw BootstrapIPCError.messageTooLarge }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else { throw response ? BootstrapIPCError.invalidResponse : BootstrapIPCError.invalidRequest }
        return dictionary
    }

    static func integer(_ value: Any?, in range: ClosedRange<Double>) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let value = number.doubleValue
        return value.isFinite && value.rounded(.towardZero) == value && range.contains(value)
    }

    private static func boundedASCII(_ value: Any?, maximum: Int) -> Bool {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= maximum else { return false }
        return text.utf8.allSatisfy { (32...126).contains($0) }
    }

    static func isCanonicalKey(_ value: String) -> Bool {
        guard value.utf8.count == 43,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 })
        else { return false }
        let padded = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="
        guard let bytes = Data(base64Encoded: padded), bytes.count == 32 else { return false }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
    }
}
