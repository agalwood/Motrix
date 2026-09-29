#ifndef MOTRIX_SAFARI_BOOTSTRAP_H
#define MOTRIX_SAFARI_BOOTSTRAP_H
#include <stddef.h>
#include <stdint.h>
/* The embedding XPC service authenticates the peer before calling this ABI.
 * The response buffer must have capacity >= 16384; buffers must not overlap.
 * A zero return value means invalid buffers or an unavailable response. */
size_t motrix_safari_bootstrap_v1(const uint8_t *request, size_t request_len,
                                uint8_t *response, size_t response_capacity);
#endif
