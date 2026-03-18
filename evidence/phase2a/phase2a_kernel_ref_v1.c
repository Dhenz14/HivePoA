/*
 * phase2a_kernel_ref_v1.c
 *
 * Normative C99 reference implementation for HivePoA Phase 2A kernel contract.
 *
 * THIS FILE IS THE SPEC. The C code defines canonical behavior.
 * Worker implementations may optimize freely but must match digests exactly.
 *
 * Frozen design points:
 * - stage_nonce = SHA-256(root_nonce_ascii || stage_index_le32)
 * - stateless SplitMix64 stream expansion (counter-based, random-access)
 * - integer-only narrow GEMM core: Y = A[M,N] * X[N,K] mod 2^32
 * - deterministic double-buffered mix/permutation pass
 * - canonical final digest:
 *     SHA-256(domain_tag || metadata_le || stage_nonce || Z_final_le_bytes)
 * - kernel_id is length-prefixed in digest metadata (blessed 2026-03-17)
 *
 * Build:
 *   cc -std=c99 -O2 -o phase2a_kernel_ref_v1 phase2a_kernel_ref_v1.c
 *
 * Usage:
 *   ./phase2a_kernel_ref_v1 --selftest
 *   ./phase2a_kernel_ref_v1 --golden
 *   ./phase2a_kernel_ref_v1 --digest <root_nonce> <class_id> <stage> <M> <N> <K> <mix_rounds>
 *   ./phase2a_kernel_ref_v1 --digest-profile <root_nonce> <class_id> <stage>
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

/* ======================== Constants ======================== */

#define PHASE2A_PROTOCOL_VERSION   1u
#define PHASE2A_KERNEL_ID          "phase2a-kernel-v1"
#define PHASE2A_DOMAIN_TAG         "HIVEPOA_PHASE2A_K1"
#define PHASE2A_PROTOCOL_CONSTANT  0x48495645504F4131ULL  /* "HIVEPOA1" ASCII */
#define PHASE2A_STAGES_PER_CHALLENGE 5u

typedef enum {
    GPU_SMALL  = 1,
    GPU_MEDIUM = 2,
    GPU_LARGE  = 3
} resource_class_id_t;

typedef struct {
    uint32_t resource_class_id;
    const char *name;
    uint32_t M, N, K, mix_rounds;
} phase2a_profile_t;

typedef struct {
    uint32_t M, N, K, mix_rounds;
} phase2a_shape_t;

static const phase2a_profile_t PROFILES[] = {
    { GPU_SMALL,  "gpu-small",  4096u, 4096u, 8u, 1u },
    { GPU_MEDIUM, "gpu-medium", 8192u, 4096u, 8u, 2u },
    { GPU_LARGE,  "gpu-large",  8192u, 8192u, 8u, 2u },
};
#define PROFILE_COUNT (sizeof(PROFILES) / sizeof(PROFILES[0]))

static void die(const char *msg) {
    fprintf(stderr, "FATAL: %s\n", msg);
    exit(1);
}

/* ======================== SHA-256 ======================== */
/*
 * Self-contained FIPS 180-4 SHA-256. No external dependencies.
 * Validated against NIST test vectors before any protocol use.
 */

typedef struct {
    uint32_t h[8];
    uint8_t  buf[64];
    uint64_t total_bytes;
    size_t   buf_used;
} sha256_ctx_t;

static uint32_t rotr32(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32u - n));
}

static uint32_t ch(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (~x & z);
}

static uint32_t maj(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (x & z) ^ (y & z);
}

static uint32_t bsig0(uint32_t x) {
    return rotr32(x, 2) ^ rotr32(x, 13) ^ rotr32(x, 22);
}

static uint32_t bsig1(uint32_t x) {
    return rotr32(x, 6) ^ rotr32(x, 11) ^ rotr32(x, 25);
}

static uint32_t ssig0(uint32_t x) {
    return rotr32(x, 7) ^ rotr32(x, 18) ^ (x >> 3);
}

static uint32_t ssig1(uint32_t x) {
    return rotr32(x, 17) ^ rotr32(x, 19) ^ (x >> 10);
}

static const uint32_t SHA256_K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static uint32_t load_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] <<  8) | ((uint32_t)p[3]);
}

static void store_be32(uint8_t *p, uint32_t x) {
    p[0] = (uint8_t)(x >> 24);
    p[1] = (uint8_t)(x >> 16);
    p[2] = (uint8_t)(x >>  8);
    p[3] = (uint8_t)(x);
}

static void sha256_compress(sha256_ctx_t *ctx, const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = load_be32(block + 4 * i);
    for (int i = 16; i < 64; i++)
        w[i] = ssig1(w[i-2]) + w[i-7] + ssig0(w[i-15]) + w[i-16];

    uint32_t a = ctx->h[0], b = ctx->h[1], c = ctx->h[2], d = ctx->h[3];
    uint32_t e = ctx->h[4], f = ctx->h[5], g = ctx->h[6], h = ctx->h[7];

    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + bsig1(e) + ch(e, f, g) + SHA256_K[i] + w[i];
        uint32_t t2 = bsig0(a) + maj(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    ctx->h[0] += a; ctx->h[1] += b; ctx->h[2] += c; ctx->h[3] += d;
    ctx->h[4] += e; ctx->h[5] += f; ctx->h[6] += g; ctx->h[7] += h;
}

static void sha256_init(sha256_ctx_t *ctx) {
    ctx->h[0] = 0x6a09e667u; ctx->h[1] = 0xbb67ae85u;
    ctx->h[2] = 0x3c6ef372u; ctx->h[3] = 0xa54ff53au;
    ctx->h[4] = 0x510e527fu; ctx->h[5] = 0x9b05688cu;
    ctx->h[6] = 0x1f83d9abu; ctx->h[7] = 0x5be0cd19u;
    ctx->total_bytes = 0;
    ctx->buf_used = 0;
}

static void sha256_update(sha256_ctx_t *ctx, const uint8_t *data, size_t len) {
    ctx->total_bytes += len;
    while (len > 0) {
        size_t take = 64 - ctx->buf_used;
        if (take > len) take = len;
        memcpy(ctx->buf + ctx->buf_used, data, take);
        ctx->buf_used += take;
        data += take;
        len -= take;
        if (ctx->buf_used == 64) {
            sha256_compress(ctx, ctx->buf);
            ctx->buf_used = 0;
        }
    }
}

static void sha256_final(sha256_ctx_t *ctx, uint8_t out[32]) {
    uint64_t total_bits = ctx->total_bytes * 8;

    /* Padding: append 0x80, then zeros, then 64-bit big-endian bit length */
    ctx->buf[ctx->buf_used++] = 0x80u;
    if (ctx->buf_used > 56) {
        while (ctx->buf_used < 64)
            ctx->buf[ctx->buf_used++] = 0;
        sha256_compress(ctx, ctx->buf);
        ctx->buf_used = 0;
    }
    while (ctx->buf_used < 56)
        ctx->buf[ctx->buf_used++] = 0;

    for (int i = 7; i >= 0; i--)
        ctx->buf[ctx->buf_used++] = (uint8_t)(total_bits >> (i * 8));
    sha256_compress(ctx, ctx->buf);

    for (int i = 0; i < 8; i++)
        store_be32(out + 4 * i, ctx->h[i]);
}

/* Convenience: hash a single buffer */
static void sha256_oneshot(const uint8_t *data, size_t len, uint8_t out[32]) {
    sha256_ctx_t ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, data, len);
    sha256_final(&ctx, out);
}

/* ======================== SHA-256 Self-Tests ======================== */
/*
 * NIST FIPS 180-4 test vectors. These MUST pass before any protocol
 * operation. --golden refuses to run if self-tests fail.
 */

static void hex_encode(const uint8_t *in, size_t len, char *out) {
    static const char HEX[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2*i]     = HEX[in[i] >> 4];
        out[2*i + 1] = HEX[in[i] & 0x0f];
    }
    out[2*len] = '\0';
}

static int hex_decode(const char *hex, uint8_t *out, size_t out_len) {
    size_t hex_len = strlen(hex);
    if (hex_len != out_len * 2) return -1;
    for (size_t i = 0; i < out_len; i++) {
        unsigned hi, lo;
        if (sscanf(hex + 2*i, "%1x", &hi) != 1) return -1;
        if (sscanf(hex + 2*i + 1, "%1x", &lo) != 1) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

typedef struct {
    const char *input;
    const char *expected_hex;
    const char *label;
} sha256_test_vector_t;

static const sha256_test_vector_t SHA256_VECTORS[] = {
    {
        "",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "NIST: empty string"
    },
    {
        "abc",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "NIST: \"abc\""
    },
    {
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        "NIST: 448-bit (two-block)"
    },
};
#define SHA256_VECTOR_COUNT (sizeof(SHA256_VECTORS) / sizeof(SHA256_VECTORS[0]))

/*
 * Returns 0 on success, nonzero on failure.
 * Prints results to stdout.
 */
static int sha256_selftest(int verbose) {
    int failures = 0;

    for (size_t i = 0; i < SHA256_VECTOR_COUNT; i++) {
        const sha256_test_vector_t *tv = &SHA256_VECTORS[i];
        uint8_t digest[32];
        char digest_hex[65];
        uint8_t expected[32];

        sha256_oneshot((const uint8_t *)tv->input, strlen(tv->input), digest);
        hex_encode(digest, 32, digest_hex);

        if (hex_decode(tv->expected_hex, expected, 32) != 0) {
            fprintf(stderr, "  BAD TEST VECTOR hex: %s\n", tv->label);
            failures++;
            continue;
        }

        int match = (memcmp(digest, expected, 32) == 0);
        if (verbose) {
            printf("  %-40s %s\n", tv->label, match ? "PASS" : "FAIL");
            if (!match) {
                printf("    expected: %s\n", tv->expected_hex);
                printf("    got:      %s\n", digest_hex);
            }
        }
        if (!match) failures++;
    }

    return failures;
}

/* ======================== Byte helpers ======================== */

static void store_le32(uint8_t out[4], uint32_t x) {
    out[0] = (uint8_t)(x);
    out[1] = (uint8_t)(x >> 8);
    out[2] = (uint8_t)(x >> 16);
    out[3] = (uint8_t)(x >> 24);
}

static uint64_t load_le64(const uint8_t in[8]) {
    uint64_t r = 0;
    for (int i = 7; i >= 0; i--)
        r = (r << 8) | in[i];
    return r;
}

static uint32_t rotl32(uint32_t x, uint32_t r) {
    r &= 31u;
    return (x << r) | (x >> ((32u - r) & 31u));
}

/* ======================== SplitMix64 PRNG ======================== */

static uint64_t mix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    x = x ^ (x >> 31);
    return x;
}

static uint64_t stream_base(const uint8_t stage_nonce[32], uint32_t stream_id) {
    uint64_t seed64 = load_le64(stage_nonce);
    return seed64 ^ ((uint64_t)stream_id << 32) ^ PHASE2A_PROTOCOL_CONSTANT;
}

static uint32_t stream_u32(const uint8_t stage_nonce[32], uint32_t stream_id,
                           uint64_t index) {
    const uint64_t gamma = 0x9E3779B97F4A7C15ULL;
    uint64_t base = stream_base(stage_nonce, stream_id);
    return (uint32_t)mix64(base + index * gamma);
}

/* ======================== Nonce derivation ======================== */

static void derive_stage_nonce(const char *root_nonce_ascii,
                               uint32_t stage_index,
                               uint8_t out[32]) {
    sha256_ctx_t ctx;
    uint8_t le_idx[4];

    sha256_init(&ctx);
    sha256_update(&ctx, (const uint8_t *)root_nonce_ascii,
                  strlen(root_nonce_ascii));
    store_le32(le_idx, stage_index);
    sha256_update(&ctx, le_idx, 4);
    sha256_final(&ctx, out);
}

/* ======================== Tensor generation ======================== */

static void fill_tensor_u32(uint32_t *dst, uint64_t count,
                            const uint8_t stage_nonce[32],
                            uint32_t stream_id) {
    for (uint64_t i = 0; i < count; i++)
        dst[i] = stream_u32(stage_nonce, stream_id, i);
}

/* ======================== GCD ======================== */

static uint64_t gcd_u64(uint64_t a, uint64_t b) {
    while (b != 0) {
        uint64_t t = a % b;
        a = b;
        b = t;
    }
    return a;
}

/* ======================== Permutation parameters ======================== */

static void derive_perm_params(const uint8_t stage_nonce[32],
                               uint32_t round_index,
                               uint64_t L,
                               uint64_t *a_out,
                               uint64_t *b_out) {
    if (L == 0) die("L must be > 0");
    if (L == 1) { *a_out = 1; *b_out = 0; return; }

    uint64_t a = (uint64_t)stream_u32(stage_nonce, 3u,
                                       (uint64_t)round_index * 2u) | 1ULL;
    uint64_t b = (uint64_t)stream_u32(stage_nonce, 3u,
                                       (uint64_t)round_index * 2u + 1u);

    a %= L;
    if ((a & 1ULL) == 0ULL) a |= 1ULL;
    if (a == 0) a = 1;

    while (gcd_u64(a, L) != 1ULL) {
        a += 2ULL;
        a %= L;
        if (a == 0) a = 1;
    }
    b %= L;

    *a_out = a;
    *b_out = b;
}

/* ======================== Compute core ======================== */
/*
 * Y = A[M,N] * X[N,K] mod 2^32
 * Row-major layout. Accumulation order: m, k, n (inner).
 * uint64_t intermediate for multiply to avoid UB.
 */

static void gemm_u32(const uint32_t *A, const uint32_t *X,
                     uint32_t M, uint32_t N, uint32_t K,
                     uint32_t *Y) {
    for (uint32_t m = 0; m < M; m++) {
        for (uint32_t k = 0; k < K; k++) {
            uint32_t acc = 0;
            for (uint32_t n = 0; n < N; n++) {
                uint32_t aval = A[(uint64_t)m * N + n];
                uint32_t xval = X[(uint64_t)n * K + k];
                uint32_t prod = (uint32_t)((uint64_t)aval * (uint64_t)xval);
                acc = (uint32_t)(acc + prod);
            }
            Y[(uint64_t)m * K + k] = acc;
        }
    }
}

/* ======================== Mix / permutation pass ======================== */
/*
 * Double-buffered. Explicit pointer swap each round.
 * mask index = round * L + t (different masks per round).
 * Permutation params (a, b) are per-round from stream 3.
 */

static void mix_pass(const uint32_t *Y,
                     uint32_t M, uint32_t K, uint32_t mix_rounds,
                     const uint8_t stage_nonce[32],
                     uint32_t *buf_a, uint32_t *buf_b,
                     uint32_t **final_out) {
    uint64_t L = (uint64_t)M * (uint64_t)K;
    if (L == 0) die("mix_pass: L must be > 0");

    memcpy(buf_a, Y, (size_t)L * sizeof(uint32_t));

    uint32_t *src = buf_a;
    uint32_t *dst = buf_b;

    for (uint32_t round = 0; round < mix_rounds; round++) {
        uint64_t a, b;
        derive_perm_params(stage_nonce, round, L, &a, &b);

        for (uint64_t t = 0; t < L; t++) {
            uint32_t mask = stream_u32(stage_nonce, 2u,
                                        (uint64_t)round * L + t);
            uint64_t idx = (a * t + b) % L;
            dst[t] = rotl32(src[idx] ^ mask, (uint32_t)(t & 31ULL));
        }

        /* Swap buffers */
        uint32_t *tmp = src;
        src = dst;
        dst = tmp;
    }

    *final_out = src;
}

/* ======================== Final digest ======================== */
/*
 * SHA-256(domain_tag || metadata || stage_nonce || Z_final_le_bytes)
 *
 * Metadata field order (frozen):
 *   protocol_version      le32
 *   kernel_id_length       le32   (length-prefixed, blessed 2026-03-17)
 *   kernel_id              raw ASCII bytes
 *   resource_class_id      le32
 *   stage_index            le32
 *   M                      le32
 *   N                      le32
 *   K                      le32
 *   mix_rounds             le32
 *   stage_nonce            32 bytes raw
 *   Z_final                M*K uint32 values as le bytes
 */

static void sha256_feed_le32(sha256_ctx_t *ctx, uint32_t x) {
    uint8_t le[4];
    store_le32(le, x);
    sha256_update(ctx, le, 4);
}

static void compute_final_digest(uint32_t resource_class_id,
                                 uint32_t stage_index,
                                 phase2a_shape_t shape,
                                 const uint8_t stage_nonce[32],
                                 const uint32_t *Z,
                                 uint8_t out[32]) {
    sha256_ctx_t ctx;
    sha256_init(&ctx);

    /* Domain tag (raw ASCII, no length prefix, no null terminator) */
    sha256_update(&ctx, (const uint8_t *)PHASE2A_DOMAIN_TAG,
                  strlen(PHASE2A_DOMAIN_TAG));

    /* Metadata */
    sha256_feed_le32(&ctx, PHASE2A_PROTOCOL_VERSION);
    sha256_feed_le32(&ctx, (uint32_t)strlen(PHASE2A_KERNEL_ID));
    sha256_update(&ctx, (const uint8_t *)PHASE2A_KERNEL_ID,
                  strlen(PHASE2A_KERNEL_ID));
    sha256_feed_le32(&ctx, resource_class_id);
    sha256_feed_le32(&ctx, stage_index);
    sha256_feed_le32(&ctx, shape.M);
    sha256_feed_le32(&ctx, shape.N);
    sha256_feed_le32(&ctx, shape.K);
    sha256_feed_le32(&ctx, shape.mix_rounds);

    /* Stage nonce */
    sha256_update(&ctx, stage_nonce, 32);

    /* Z_final as little-endian uint32 stream */
    {
        uint64_t L = (uint64_t)shape.M * (uint64_t)shape.K;
        uint8_t le[4];
        for (uint64_t i = 0; i < L; i++) {
            store_le32(le, Z[i]);
            sha256_update(&ctx, le, 4);
        }
    }

    sha256_final(&ctx, out);
}

/* ======================== Stage digest (full pipeline) ======================== */

static int compute_stage_digest(const char *root_nonce_ascii,
                                uint32_t stage_index,
                                uint32_t resource_class_id,
                                phase2a_shape_t shape,
                                uint8_t out_stage_nonce[32],
                                uint8_t out_digest[32]) {
    if (shape.M == 0 || shape.N == 0 || shape.K == 0 || shape.mix_rounds == 0)
        return -1;

    derive_stage_nonce(root_nonce_ascii, stage_index, out_stage_nonce);

    uint64_t count_A = (uint64_t)shape.M * shape.N;
    uint64_t count_X = (uint64_t)shape.N * shape.K;
    uint64_t count_Y = (uint64_t)shape.M * shape.K;

    uint32_t *A  = (uint32_t *)malloc((size_t)count_A * sizeof(uint32_t));
    uint32_t *X  = (uint32_t *)malloc((size_t)count_X * sizeof(uint32_t));
    uint32_t *Y  = (uint32_t *)malloc((size_t)count_Y * sizeof(uint32_t));
    uint32_t *ba = (uint32_t *)malloc((size_t)count_Y * sizeof(uint32_t));
    uint32_t *bb = (uint32_t *)malloc((size_t)count_Y * sizeof(uint32_t));

    if (!A || !X || !Y || !ba || !bb) {
        free(A); free(X); free(Y); free(ba); free(bb);
        return -2;
    }

    fill_tensor_u32(A, count_A, out_stage_nonce, 0u);
    fill_tensor_u32(X, count_X, out_stage_nonce, 1u);
    gemm_u32(A, X, shape.M, shape.N, shape.K, Y);

    uint32_t *Z = NULL;
    mix_pass(Y, shape.M, shape.K, shape.mix_rounds,
             out_stage_nonce, ba, bb, &Z);
    compute_final_digest(resource_class_id, stage_index, shape,
                         out_stage_nonce, Z, out_digest);

    free(A); free(X); free(Y); free(ba); free(bb);
    return 0;
}

/* ======================== Profile lookup ======================== */

static phase2a_shape_t shape_from_profile(uint32_t class_id) {
    for (size_t i = 0; i < PROFILE_COUNT; i++) {
        if (PROFILES[i].resource_class_id == class_id) {
            phase2a_shape_t s = {
                PROFILES[i].M, PROFILES[i].N,
                PROFILES[i].K, PROFILES[i].mix_rounds
            };
            return s;
        }
    }
    die("unknown resource class id");
    return (phase2a_shape_t){0, 0, 0, 0};
}

/* ======================== Output ======================== */

static void print_digest_line(const char *root_nonce,
                              uint32_t class_id,
                              uint32_t stage_index,
                              phase2a_shape_t shape) {
    uint8_t stage_nonce[32], digest[32];
    char sn_hex[65], d_hex[65];

    int rc = compute_stage_digest(root_nonce, stage_index, class_id,
                                  shape, stage_nonce, digest);
    if (rc != 0) die("compute_stage_digest failed");

    hex_encode(stage_nonce, 32, sn_hex);
    hex_encode(digest, 32, d_hex);

    printf("root_nonce=%s class_id=%u stage=%u "
           "M=%u N=%u K=%u mix_rounds=%u\n"
           "stage_nonce=%s\n"
           "digest=%s\n\n",
           root_nonce, class_id, stage_index,
           shape.M, shape.N, shape.K, shape.mix_rounds,
           sn_hex, d_hex);
}

/* ======================== Golden vectors ======================== */

typedef struct {
    uint32_t class_id;
    uint32_t stage_index;
    phase2a_shape_t shape;
    const char *expected_digest;
} golden_vector_t;

/*
 * These are the authoritative golden vectors for phase2a-kernel-v1.
 * Root nonce: "11111111-2222-3333-4444-555555555555"
 *
 * IMPORTANT: These digests were generated by this reference implementation
 * AFTER SHA-256 self-tests pass. If any digest changes, either the reference
 * is wrong or the vector is stale. Both cases require investigation.
 *
 * Set to empty string "" initially — filled after first trusted run.
 */
static const char *GOLDEN_ROOT_NONCE = "11111111-2222-3333-4444-555555555555";

static const golden_vector_t GOLDEN_VECTORS[] = {
    /* Tiny shapes for fast CI — cross-validated against independent impl */
    { GPU_SMALL,  0, { 8, 8, 2, 1},
      "5c1fc61233c1342b1d77b993ee690bcb03ff26e5acb5dcab927177aef59d5f3a" },
    { GPU_MEDIUM, 1, {16, 8, 2, 2},
      "1adca8b732246c0a2045d27953c717e62d09688b0593befc043105726f3562e1" },
    { GPU_LARGE,  2, {16,16, 4, 2},
      "21c31aebe3efedc19c8c2904b3dabc24742a9adc9a0e0ee59c835f0d79219438" },
};
#define GOLDEN_VECTOR_COUNT (sizeof(GOLDEN_VECTORS) / sizeof(GOLDEN_VECTORS[0]))

/*
 * Verify golden vectors: compute each digest and compare to embedded expected.
 * Returns number of failures (0 = all pass).
 */
static int verify_golden_vectors(int verbose) {
    int failures = 0;

    for (size_t i = 0; i < GOLDEN_VECTOR_COUNT; i++) {
        const golden_vector_t *gv = &GOLDEN_VECTORS[i];
        uint8_t stage_nonce[32], digest[32];
        char digest_hex[65];

        if (gv->expected_digest[0] == '\0') {
            if (verbose)
                printf("  [%zu] class=%u stage=%u — SKIP (no expected digest)\n",
                       i, gv->class_id, gv->stage_index);
            continue;
        }

        int rc = compute_stage_digest(GOLDEN_ROOT_NONCE, gv->stage_index,
                                      gv->class_id, gv->shape,
                                      stage_nonce, digest);
        if (rc != 0) {
            if (verbose)
                printf("  [%zu] class=%u stage=%u — FAIL (compute error %d)\n",
                       i, gv->class_id, gv->stage_index, rc);
            failures++;
            continue;
        }

        hex_encode(digest, 32, digest_hex);
        int match = (strcmp(digest_hex, gv->expected_digest) == 0);

        if (verbose) {
            printf("  [%zu] class=%u stage=%u M=%u N=%u K=%u r=%u  %s\n",
                   i, gv->class_id, gv->stage_index,
                   gv->shape.M, gv->shape.N, gv->shape.K, gv->shape.mix_rounds,
                   match ? "PASS" : "FAIL");
            if (!match) {
                printf("    expected: %s\n", gv->expected_digest);
                printf("    got:      %s\n", digest_hex);
            }
        }
        if (!match) failures++;
    }

    return failures;
}

static void cmd_golden(void) {
    /* Fail-closed: SHA-256 must pass first */
    printf("=== SHA-256 self-test ===\n");
    int sha_failures = sha256_selftest(1);
    if (sha_failures > 0) {
        printf("\nSHA-256 SELF-TEST FAILED (%d failures)\n", sha_failures);
        printf("Golden vectors NOT generated — root of trust broken.\n");
        exit(2);
    }
    printf("SHA-256 self-test: ALL PASS\n\n");

    /* Verify embedded golden vectors before printing */
    printf("=== Golden vector verification ===\n");
    int gv_failures = verify_golden_vectors(1);
    if (gv_failures > 0) {
        printf("\nGOLDEN VECTOR VERIFICATION FAILED (%d failures)\n",
               gv_failures);
        printf("Reference implementation drift detected.\n");
        exit(3);
    }
    printf("Golden vector verification: ALL PASS\n\n");

    printf("=== phase2a-kernel-v1 golden vectors ===\n");
    printf("root_nonce=%s\n\n", GOLDEN_ROOT_NONCE);

    for (size_t i = 0; i < GOLDEN_VECTOR_COUNT; i++) {
        const golden_vector_t *gv = &GOLDEN_VECTORS[i];
        print_digest_line(GOLDEN_ROOT_NONCE, gv->class_id,
                          gv->stage_index, gv->shape);
    }

    printf("protocol_version=%u\n", PHASE2A_PROTOCOL_VERSION);
    printf("kernel_id=%s\n", PHASE2A_KERNEL_ID);
    printf("stages_per_challenge=%u\n", PHASE2A_STAGES_PER_CHALLENGE);
    printf("pool_rule=2x max_concurrent_challenges x stages_per_challenge per class\n");
}

/* ======================== Self-test command ======================== */

static int cmd_selftest(void) {
    printf("=== SHA-256 self-test (NIST FIPS 180-4) ===\n");
    int failures = sha256_selftest(1);
    printf("\n");

    if (failures > 0) {
        printf("RESULT: FAIL (%d failures)\n", failures);
        printf("DO NOT TRUST any digests from this build.\n");
        return 1;
    }

    printf("RESULT: ALL PASS (%zu vectors)\n", SHA256_VECTOR_COUNT);
    printf("SHA-256 root of trust validated.\n");
    return 0;
}

/* ======================== Main ======================== */

static int cmd_verify(void) {
    printf("=== SHA-256 self-test ===\n");
    int sha_failures = sha256_selftest(1);
    if (sha_failures > 0) {
        printf("SHA-256 SELF-TEST FAILED (%d)\n", sha_failures);
        return 2;
    }
    printf("SHA-256: ALL PASS\n\n");

    printf("=== Golden vector verification ===\n");
    int gv_failures = verify_golden_vectors(1);
    printf("\n");
    if (gv_failures > 0) {
        printf("RESULT: FAIL (%d golden vector failures)\n", gv_failures);
        return 3;
    }
    printf("RESULT: ALL PASS (SHA-256: %zu vectors, golden: %zu vectors)\n",
           SHA256_VECTOR_COUNT, GOLDEN_VECTOR_COUNT);
    return 0;
}

static void print_usage(const char *argv0) {
    fprintf(stderr,
        "Usage:\n"
        "  %s --selftest\n"
        "      Validate SHA-256 against NIST test vectors.\n"
        "  %s --verify\n"
        "      Run SHA-256 self-test + golden vector verification.\n"
        "  %s --golden\n"
        "      Print golden vectors (fails if verification fails).\n"
        "  %s --digest <root_nonce> <class_id> <stage> <M> <N> <K> <mix_rounds>\n"
        "      Compute digest for arbitrary parameters.\n"
        "  %s --digest-profile <root_nonce> <class_id> <stage>\n"
        "      Compute digest using default profile for the class.\n",
        argv0, argv0, argv0, argv0, argv0);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        print_usage(argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "--selftest") == 0) {
        return cmd_selftest();
    }

    if (strcmp(argv[1], "--verify") == 0) {
        return cmd_verify();
    }

    if (strcmp(argv[1], "--golden") == 0) {
        cmd_golden();
        return 0;
    }

    if (strcmp(argv[1], "--digest") == 0 && argc == 9) {
        const char *root_nonce = argv[2];
        uint32_t class_id   = (uint32_t)strtoul(argv[3], NULL, 10);
        uint32_t stage      = (uint32_t)strtoul(argv[4], NULL, 10);
        phase2a_shape_t shape;
        shape.M          = (uint32_t)strtoul(argv[5], NULL, 10);
        shape.N          = (uint32_t)strtoul(argv[6], NULL, 10);
        shape.K          = (uint32_t)strtoul(argv[7], NULL, 10);
        shape.mix_rounds = (uint32_t)strtoul(argv[8], NULL, 10);
        print_digest_line(root_nonce, class_id, stage, shape);
        return 0;
    }

    if (strcmp(argv[1], "--digest-profile") == 0 && argc == 5) {
        const char *root_nonce = argv[2];
        uint32_t class_id = (uint32_t)strtoul(argv[3], NULL, 10);
        uint32_t stage    = (uint32_t)strtoul(argv[4], NULL, 10);
        print_digest_line(root_nonce, class_id, stage,
                          shape_from_profile(class_id));
        return 0;
    }

    print_usage(argv[0]);
    return 1;
}
