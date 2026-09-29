#ifndef MOTRIX_SAFARI_BOOTSTRAP_H
#define MOTRIX_SAFARI_BOOTSTRAP_H
#include <stddef.h>
#include <stdint.h>
/* The embedding XPC service authenticates the peer before calling this ABI.
 * The response buffer must have capacity >= 16384; buffers must not overlap.
 * A zero return value means invalid buffers or an unavailable response. */
size_t motrix_safari_bootstrap_v1(const uint8_t *request, size_t request_len,
                                uint8_t *response, size_t response_capacity);
/* Private desktop result. JSON remains protocol v1. bridge_not_running is 1
 * only when discovery found no live bridge; nonce refusal is terminal (0).
 * Invalid buffers return {0, 0}. The v1 buffer safety contract also applies. */
typedef struct {
    size_t response_len;
    uint8_t bridge_not_running;
} MotrixSafariBootstrapResult;
MotrixSafariBootstrapResult motrix_safari_bootstrap_v2(
    const uint8_t *request, size_t request_len,
    uint8_t *response, size_t response_capacity);
#endif
