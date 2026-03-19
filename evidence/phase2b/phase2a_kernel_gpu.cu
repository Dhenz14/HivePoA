/*
 * phase2a_kernel_gpu.cu
 *
 * CUDA port of phase2a_kernel_ref_v1.c for GPU calibration measurement.
 * Calibration tooling — NOT product code.
 *
 * Must produce IDENTICAL digests to the C99 reference implementation.
 * SHA-256 and nonce derivation run on CPU (same code as reference).
 * Matrix generation, GEMM, and mix/permutation run on GPU.
 *
 * Build (WSL with CUDA toolkit):
 *   nvcc -O2 -arch=sm_89 -o phase2a_kernel_gpu phase2a_kernel_gpu.cu
 *
 * Usage:
 *   ./phase2a_kernel_gpu --selftest              (golden vector verification)
 *   ./phase2a_kernel_gpu --bench M N K R [runs]  (benchmark given dimensions)
 *   ./phase2a_kernel_gpu --bench-profiles         (all Phase 2A+2B profiles)
 *   ./phase2a_kernel_gpu --info                   (GPU info)
 *   ./phase2a_kernel_gpu --digest ROOT CID SI M N K MR   (mirrors C99 ref interface)
 *   ./phase2a_kernel_gpu --compute NONCE CID SI M N K MR (staging worker mode)
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cinttypes>
#include <ctime>
#include <cuda_runtime.h>

/* ======================== Error handling ======================== */

#define CUDA_CHECK(call) do { \
    cudaError_t err = (call); \
    if (err != cudaSuccess) { \
        fprintf(stderr, "CUDA error at %s:%d: %s\n", \
                __FILE__, __LINE__, cudaGetErrorString(err)); \
        exit(1); \
    } \
} while(0)

static void die(const char *msg) {
    fprintf(stderr, "FATAL: %s\n", msg);
    exit(1);
}

/* ======================== Constants ======================== */

#define PHASE2A_PROTOCOL_VERSION   1u
#define PHASE2A_KERNEL_ID          "phase2a-kernel-v1"
#define PHASE2A_DOMAIN_TAG         "HIVEPOA_PHASE2A_K1"
#define PHASE2A_PROTOCOL_CONSTANT  0x48495645504F4131ULL
#define SPLITMIX_GAMMA             0x9E3779B97F4A7C15ULL

/* ======================== SHA-256 (host, identical to reference) ======================== */

typedef struct {
    uint32_t h[8];
    uint8_t  buf[64];
    uint64_t total_bytes;
    size_t   buf_used;
} sha256_ctx_t;

static uint32_t rotr32(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32u - n));
}

static uint32_t sha_ch(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (~x & z);
}

static uint32_t sha_maj(uint32_t x, uint32_t y, uint32_t z) {
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
        uint32_t t1 = h + bsig1(e) + sha_ch(e, f, g) + SHA256_K[i] + w[i];
        uint32_t t2 = bsig0(a) + sha_maj(a, b, c);
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

static void sha256_oneshot(const uint8_t *data, size_t len, uint8_t out[32]) {
    sha256_ctx_t ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, data, len);
    sha256_final(&ctx, out);
}

/* ======================== Byte helpers (host) ======================== */

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

static void hex_encode(const uint8_t *in, size_t len, char *out) {
    static const char HEX[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2*i]     = HEX[in[i] >> 4];
        out[2*i + 1] = HEX[in[i] & 0x0f];
    }
    out[2*len] = '\0';
}

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int hex_decode(const char *hex, uint8_t *out, size_t out_len) {
    if (strlen(hex) != out_len * 2) return -1;
    for (size_t i = 0; i < out_len; i++) {
        int hi = hex_val(hex[2*i]);
        int lo = hex_val(hex[2*i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

/* ======================== SplitMix64 (host) ======================== */

static uint64_t mix64_host(uint64_t x) {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    x = x ^ (x >> 31);
    return x;
}

static uint64_t stream_base_host(const uint8_t stage_nonce[32], uint32_t stream_id) {
    uint64_t seed64 = load_le64(stage_nonce);
    return seed64 ^ ((uint64_t)stream_id << 32) ^ PHASE2A_PROTOCOL_CONSTANT;
}

static uint32_t stream_u32_host(const uint8_t stage_nonce[32], uint32_t stream_id,
                                uint64_t index) {
    uint64_t base = stream_base_host(stage_nonce, stream_id);
    return (uint32_t)mix64_host(base + index * SPLITMIX_GAMMA);
}

/* ======================== Nonce derivation (host) ======================== */

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

/* ======================== Permutation params (host) ======================== */

static uint64_t gcd_u64(uint64_t a, uint64_t b) {
    while (b != 0) { uint64_t t = a % b; a = b; b = t; }
    return a;
}

static void derive_perm_params(const uint8_t stage_nonce[32],
                               uint32_t round_index,
                               uint64_t L,
                               uint64_t *a_out, uint64_t *b_out) {
    if (L == 0) die("L must be > 0");
    if (L == 1) { *a_out = 1; *b_out = 0; return; }

    uint64_t a = (uint64_t)stream_u32_host(stage_nonce, 3u,
                                            (uint64_t)round_index * 2u) | 1ULL;
    uint64_t b = (uint64_t)stream_u32_host(stage_nonce, 3u,
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

/* ======================== Final digest (host) ======================== */

static void sha256_feed_le32(sha256_ctx_t *ctx, uint32_t x) {
    uint8_t le[4];
    store_le32(le, x);
    sha256_update(ctx, le, 4);
}

static void compute_final_digest(uint32_t resource_class_id,
                                 uint32_t stage_index,
                                 uint32_t M, uint32_t N, uint32_t K,
                                 uint32_t mix_rounds,
                                 const uint8_t stage_nonce[32],
                                 const uint32_t *Z,
                                 uint8_t out[32]) {
    sha256_ctx_t ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, (const uint8_t *)PHASE2A_DOMAIN_TAG,
                  strlen(PHASE2A_DOMAIN_TAG));
    sha256_feed_le32(&ctx, PHASE2A_PROTOCOL_VERSION);
    sha256_feed_le32(&ctx, (uint32_t)strlen(PHASE2A_KERNEL_ID));
    sha256_update(&ctx, (const uint8_t *)PHASE2A_KERNEL_ID,
                  strlen(PHASE2A_KERNEL_ID));
    sha256_feed_le32(&ctx, resource_class_id);
    sha256_feed_le32(&ctx, stage_index);
    sha256_feed_le32(&ctx, M);
    sha256_feed_le32(&ctx, N);
    sha256_feed_le32(&ctx, K);
    sha256_feed_le32(&ctx, mix_rounds);
    sha256_update(&ctx, stage_nonce, 32);

    /* Z_final as little-endian uint32 stream */
    uint64_t L = (uint64_t)M * (uint64_t)K;
    uint8_t le[4];
    for (uint64_t i = 0; i < L; i++) {
        store_le32(le, Z[i]);
        sha256_update(&ctx, le, 4);
    }
    sha256_final(&ctx, out);
}

/* ======================== GPU device functions ======================== */

__device__ uint64_t mix64_d(uint64_t x) {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    x = x ^ (x >> 31);
    return x;
}

__device__ uint32_t rotl32_d(uint32_t x, uint32_t r) {
    r &= 31u;
    return (x << r) | (x >> ((32u - r) & 31u));
}

/* ======================== CUDA kernels ======================== */

/*
 * Fill tensor with SplitMix64 PRNG output.
 * Each thread generates one element: dst[i] = (uint32_t)mix64(base + i * gamma)
 */
__global__ void fill_tensor_kernel(uint32_t *dst, uint64_t count,
                                    uint64_t base, uint64_t gamma) {
    uint64_t i = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    dst[i] = (uint32_t)mix64_d(base + i * gamma);
}

/*
 * Integer GEMM: Y[M,K] = A[M,N] * X[N,K] mod 2^32
 * One thread per row of output. Each thread computes K output values.
 * K is always 8 in our profiles, so we unroll the inner K loop.
 */
__global__ void gemm_kernel(const uint32_t *A, const uint32_t *X,
                            uint32_t M, uint32_t N, uint32_t K,
                            uint32_t *Y) {
    uint32_t m = blockIdx.x * blockDim.x + threadIdx.x;
    if (m >= M) return;

    /* Accumulators for each column of output row */
    uint32_t acc0 = 0, acc1 = 0, acc2 = 0, acc3 = 0;
    uint32_t acc4 = 0, acc5 = 0, acc6 = 0, acc7 = 0;

    const uint32_t *A_row = A + (uint64_t)m * N;

    for (uint32_t n = 0; n < N; n++) {
        uint32_t aval = A_row[n];
        const uint32_t *X_row = X + (uint64_t)n * K;
        if (K >= 1) acc0 += aval * X_row[0];
        if (K >= 2) acc1 += aval * X_row[1];
        if (K >= 3) acc2 += aval * X_row[2];
        if (K >= 4) acc3 += aval * X_row[3];
        if (K >= 5) acc4 += aval * X_row[4];
        if (K >= 6) acc5 += aval * X_row[5];
        if (K >= 7) acc6 += aval * X_row[6];
        if (K >= 8) acc7 += aval * X_row[7];
    }

    uint32_t *Y_row = Y + (uint64_t)m * K;
    if (K >= 1) Y_row[0] = acc0;
    if (K >= 2) Y_row[1] = acc1;
    if (K >= 3) Y_row[2] = acc2;
    if (K >= 4) Y_row[3] = acc3;
    if (K >= 5) Y_row[4] = acc4;
    if (K >= 6) Y_row[5] = acc5;
    if (K >= 7) Y_row[6] = acc6;
    if (K >= 8) Y_row[7] = acc7;
}

/*
 * Mix/permutation: one round.
 * dst[t] = rotl32(src[(a*t+b)%L] ^ mask, t & 31)
 * mask = mix64(mask_base + t * gamma)
 */
__global__ void mix_kernel(const uint32_t *src, uint32_t *dst,
                           uint64_t L, uint64_t perm_a, uint64_t perm_b,
                           uint64_t mask_base, uint64_t mask_gamma) {
    uint64_t t = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= L) return;

    uint32_t mask = (uint32_t)mix64_d(mask_base + t * mask_gamma);
    uint64_t idx = (perm_a * t + perm_b) % L;
    dst[t] = rotl32_d(src[idx] ^ mask, (uint32_t)(t & 31ULL));
}

/* ======================== GPU stage computation ======================== */

struct stage_timing_t {
    float fill_A_ms;
    float fill_X_ms;
    float gemm_ms;
    float mix_ms;
    float d2h_ms;      /* device-to-host copy */
    float digest_ms;    /* CPU SHA-256 */
    float total_gpu_ms; /* fill + gemm + mix (GPU only) */
    float total_ms;     /* everything including digest */
};

/**
 * Core GPU computation: takes pre-derived stage_nonce bytes.
 * Used by both --digest (root_nonce → derive → core) and --compute (nonce hex → core).
 */
static int compute_stage_gpu_core(const uint8_t stage_nonce[32],
                                  uint32_t stage_index,
                                  uint32_t resource_class_id,
                                  uint32_t M, uint32_t N, uint32_t K,
                                  uint32_t mix_rounds,
                                  uint8_t out_digest[32],
                                  stage_timing_t *timing) {
    if (M == 0 || N == 0 || K == 0 || mix_rounds == 0) return -1;

    uint64_t count_A = (uint64_t)M * N;
    uint64_t count_X = (uint64_t)N * K;
    uint64_t count_Y = (uint64_t)M * K;

    /* Compute stream bases on CPU */
    uint64_t base_A = stream_base_host(stage_nonce, 0u);
    uint64_t base_X = stream_base_host(stage_nonce, 1u);
    uint64_t base_mask = stream_base_host(stage_nonce, 2u);

    /* Allocate GPU memory */
    uint32_t *d_A, *d_X, *d_Y, *d_buf_a, *d_buf_b;
    CUDA_CHECK(cudaMalloc(&d_A, (size_t)count_A * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_X, (size_t)count_X * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_Y, (size_t)count_Y * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_buf_a, (size_t)count_Y * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_buf_b, (size_t)count_Y * sizeof(uint32_t)));

    /* CUDA events for timing */
    cudaEvent_t ev_start, ev_fill_A, ev_fill_X, ev_gemm, ev_mix, ev_d2h;
    CUDA_CHECK(cudaEventCreate(&ev_start));
    CUDA_CHECK(cudaEventCreate(&ev_fill_A));
    CUDA_CHECK(cudaEventCreate(&ev_fill_X));
    CUDA_CHECK(cudaEventCreate(&ev_gemm));
    CUDA_CHECK(cudaEventCreate(&ev_mix));
    CUDA_CHECK(cudaEventCreate(&ev_d2h));

    int threads = 256;

    CUDA_CHECK(cudaEventRecord(ev_start));

    /* Fill A on GPU */
    {
        int blocks = (int)((count_A + threads - 1) / threads);
        fill_tensor_kernel<<<blocks, threads>>>(d_A, count_A,
                                                 base_A, SPLITMIX_GAMMA);
    }
    CUDA_CHECK(cudaEventRecord(ev_fill_A));

    /* Fill X on GPU */
    {
        int blocks = (int)((count_X + threads - 1) / threads);
        fill_tensor_kernel<<<blocks, threads>>>(d_X, count_X,
                                                 base_X, SPLITMIX_GAMMA);
    }
    CUDA_CHECK(cudaEventRecord(ev_fill_X));

    /* GEMM on GPU */
    {
        int blocks = (int)((M + threads - 1) / threads);
        gemm_kernel<<<blocks, threads>>>(d_A, d_X, M, N, K, d_Y);
    }
    CUDA_CHECK(cudaEventRecord(ev_gemm));

    /* Mix pass on GPU (round by round, each round is a separate kernel) */
    /* First round reads from Y, writes to buf_a. Then alternates. */
    {
        uint32_t *src = d_Y;
        uint32_t *dst = d_buf_a;

        /* Copy Y to buf_a first (mix_pass starts from a copy of Y) */
        CUDA_CHECK(cudaMemcpy(d_buf_a, d_Y,
                              (size_t)count_Y * sizeof(uint32_t),
                              cudaMemcpyDeviceToDevice));
        src = d_buf_a;
        dst = d_buf_b;

        int mix_blocks = (int)((count_Y + threads - 1) / threads);
        for (uint32_t round = 0; round < mix_rounds; round++) {
            uint64_t perm_a, perm_b;
            derive_perm_params(stage_nonce, round, count_Y, &perm_a, &perm_b);

            uint64_t round_mask_base = base_mask +
                (uint64_t)round * count_Y * SPLITMIX_GAMMA;

            mix_kernel<<<mix_blocks, threads>>>(src, dst, count_Y,
                                                 perm_a, perm_b,
                                                 round_mask_base,
                                                 SPLITMIX_GAMMA);
            /* Swap src/dst */
            uint32_t *tmp = src; src = dst; dst = tmp;
        }

        /* src now points to the final output buffer */
        /* We need to know which GPU buffer has the result */
        /* After mix_rounds swaps, result is in:
         *   rounds=1: dst was buf_b, then swap -> src=buf_b
         *   rounds=2: round0: src=buf_a->dst=buf_b, swap->src=buf_b
         *             round1: src=buf_b->dst=buf_a, swap->src=buf_a */
        /* Copy result to d_Y for simplicity */
        CUDA_CHECK(cudaMemcpy(d_Y, src,
                              (size_t)count_Y * sizeof(uint32_t),
                              cudaMemcpyDeviceToDevice));
    }
    CUDA_CHECK(cudaEventRecord(ev_mix));

    /* Copy Z result to host */
    uint32_t *h_Z = (uint32_t *)malloc((size_t)count_Y * sizeof(uint32_t));
    if (!h_Z) die("malloc failed for h_Z");
    CUDA_CHECK(cudaMemcpy(h_Z, d_Y, (size_t)count_Y * sizeof(uint32_t),
                          cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaEventRecord(ev_d2h));
    CUDA_CHECK(cudaEventSynchronize(ev_d2h));

    /* Compute SHA-256 digest on CPU */
    struct timespec ts_start, ts_end;
    clock_gettime(CLOCK_MONOTONIC, &ts_start);
    compute_final_digest(resource_class_id, stage_index,
                         M, N, K, mix_rounds,
                         stage_nonce, h_Z, out_digest);
    clock_gettime(CLOCK_MONOTONIC, &ts_end);

    /* Collect timing */
    if (timing) {
        CUDA_CHECK(cudaEventElapsedTime(&timing->fill_A_ms, ev_start, ev_fill_A));
        CUDA_CHECK(cudaEventElapsedTime(&timing->fill_X_ms, ev_fill_A, ev_fill_X));
        CUDA_CHECK(cudaEventElapsedTime(&timing->gemm_ms, ev_fill_X, ev_gemm));
        CUDA_CHECK(cudaEventElapsedTime(&timing->mix_ms, ev_gemm, ev_mix));
        CUDA_CHECK(cudaEventElapsedTime(&timing->d2h_ms, ev_mix, ev_d2h));
        timing->digest_ms = (float)((ts_end.tv_sec - ts_start.tv_sec) * 1000.0 +
                                     (ts_end.tv_nsec - ts_start.tv_nsec) / 1e6);
        CUDA_CHECK(cudaEventElapsedTime(&timing->total_gpu_ms, ev_start, ev_mix));
        timing->total_ms = timing->total_gpu_ms + timing->d2h_ms + timing->digest_ms;
    }

    /* Cleanup */
    free(h_Z);
    cudaFree(d_A);
    cudaFree(d_X);
    cudaFree(d_Y);
    cudaFree(d_buf_a);
    cudaFree(d_buf_b);
    cudaEventDestroy(ev_start);
    cudaEventDestroy(ev_fill_A);
    cudaEventDestroy(ev_fill_X);
    cudaEventDestroy(ev_gemm);
    cudaEventDestroy(ev_mix);
    cudaEventDestroy(ev_d2h);

    return 0;
}

/**
 * Original interface: derives stage_nonce from root_nonce, then delegates to core.
 * Used by --bench, --selftest, and any path that has root_nonce.
 */
static int compute_stage_gpu(const char *root_nonce_ascii,
                             uint32_t stage_index,
                             uint32_t resource_class_id,
                             uint32_t M, uint32_t N, uint32_t K,
                             uint32_t mix_rounds,
                             uint8_t out_digest[32],
                             stage_timing_t *timing) {
    uint8_t stage_nonce[32];
    derive_stage_nonce(root_nonce_ascii, stage_index, stage_nonce);
    return compute_stage_gpu_core(stage_nonce, stage_index, resource_class_id,
                                  M, N, K, mix_rounds, out_digest, timing);
}

/* ======================== Golden vector verification ======================== */

struct golden_vector_t {
    uint32_t class_id;
    uint32_t stage_index;
    uint32_t M, N, K, mix_rounds;
    const char *expected_digest;
};

static const char *GOLDEN_ROOT_NONCE = "11111111-2222-3333-4444-555555555555";

static const golden_vector_t GOLDEN_VECTORS[] = {
    { 1, 0,  8,  8, 2, 1,
      "5c1fc61233c1342b1d77b993ee690bcb03ff26e5acb5dcab927177aef59d5f3a" },
    { 2, 1, 16,  8, 2, 2,
      "1adca8b732246c0a2045d27953c717e62d09688b0593befc043105726f3562e1" },
    { 3, 2, 16, 16, 4, 2,
      "21c31aebe3efedc19c8c2904b3dabc24742a9adc9a0e0ee59c835f0d79219438" },
};
#define GOLDEN_VECTOR_COUNT (sizeof(GOLDEN_VECTORS) / sizeof(GOLDEN_VECTORS[0]))

static int cmd_selftest(void) {
    printf("=== GPU Kernel Self-Test ===\n\n");

    /* SHA-256 NIST vectors (quick sanity) */
    {
        uint8_t digest[32];
        char hex[65];
        sha256_oneshot((const uint8_t *)"abc", 3, digest);
        hex_encode(digest, 32, hex);
        int ok = (strcmp(hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0);
        printf("  SHA-256 NIST \"abc\":  %s\n", ok ? "PASS" : "FAIL");
        if (!ok) return 1;
    }

    printf("\n=== Golden Vector Verification (GPU pipeline) ===\n\n");

    int failures = 0;
    for (size_t i = 0; i < GOLDEN_VECTOR_COUNT; i++) {
        const golden_vector_t *gv = &GOLDEN_VECTORS[i];
        uint8_t digest[32];
        char digest_hex[65];

        int rc = compute_stage_gpu(GOLDEN_ROOT_NONCE, gv->stage_index,
                                   gv->class_id,
                                   gv->M, gv->N, gv->K, gv->mix_rounds,
                                   digest, NULL);
        if (rc != 0) {
            printf("  [%zu] class=%u stage=%u — FAIL (compute error %d)\n",
                   i, gv->class_id, gv->stage_index, rc);
            failures++;
            continue;
        }

        hex_encode(digest, 32, digest_hex);
        int match = (strcmp(digest_hex, gv->expected_digest) == 0);
        printf("  [%zu] class=%u stage=%u M=%u N=%u K=%u r=%u  %s\n",
               i, gv->class_id, gv->stage_index,
               gv->M, gv->N, gv->K, gv->mix_rounds,
               match ? "PASS" : "FAIL");
        if (!match) {
            printf("    expected: %s\n", gv->expected_digest);
            printf("    got:      %s\n", digest_hex);
            failures++;
        }
    }

    printf("\n");
    if (failures > 0) {
        printf("RESULT: FAIL (%d golden vector failures)\n", failures);
        printf("GPU kernel does NOT match reference implementation.\n");
        return 1;
    }
    printf("RESULT: ALL PASS (%zu vectors)\n", GOLDEN_VECTOR_COUNT);
    printf("GPU kernel produces identical digests to C99 reference.\n");
    return 0;
}

/* ======================== Benchmark ======================== */

static void print_timing(const char *label, uint32_t M, uint32_t N,
                         uint32_t K, uint32_t mix_rounds,
                         const stage_timing_t *t) {
    uint64_t working_set = (uint64_t)M * N * 4;
    printf("  %s  M=%u N=%u K=%u r=%u  working_set=%.2f GB\n",
           label, M, N, K, mix_rounds, working_set / 1e9);
    printf("    fill_A:  %8.2f ms\n", t->fill_A_ms);
    printf("    fill_X:  %8.2f ms\n", t->fill_X_ms);
    printf("    gemm:    %8.2f ms\n", t->gemm_ms);
    printf("    mix:     %8.2f ms\n", t->mix_ms);
    printf("    GPU tot: %8.2f ms\n", t->total_gpu_ms);
    printf("    D->H:    %8.2f ms\n", t->d2h_ms);
    printf("    SHA-256: %8.2f ms\n", t->digest_ms);
    printf("    TOTAL:   %8.2f ms\n", t->total_ms);
}

static void cmd_bench(uint32_t M, uint32_t N, uint32_t K,
                      uint32_t mix_rounds, int runs) {
    printf("=== GPU Benchmark: M=%u N=%u K=%u mix_rounds=%u ===\n", M, N, K, mix_rounds);

    uint64_t working_set = (uint64_t)M * N * 4;
    uint64_t total_gpu_mem = (uint64_t)M * N * 4       /* A */
                           + (uint64_t)N * K * 4       /* X */
                           + (uint64_t)M * K * 4 * 3;  /* Y + buf_a + buf_b */
    printf("Working set (A matrix): %.2f GB\n", working_set / 1e9);
    printf("Total GPU memory needed: %.2f GB\n", total_gpu_mem / 1e9);

    /* Check available memory */
    size_t free_mem, total_mem;
    CUDA_CHECK(cudaMemGetInfo(&free_mem, &total_mem));
    printf("GPU memory: %.2f GB free / %.2f GB total\n\n",
           free_mem / 1e9, total_mem / 1e9);

    if (total_gpu_mem > free_mem) {
        printf("ERROR: Not enough GPU memory. Need %.2f GB, have %.2f GB free.\n",
               total_gpu_mem / 1e9, free_mem / 1e9);
        printf("Kill GPU processes (ollama, etc.) to free VRAM.\n");
        return;
    }

    /* Warmup */
    {
        uint8_t digest[32];
        compute_stage_gpu(GOLDEN_ROOT_NONCE, 0, 1,
                          M, N, K, mix_rounds, digest, NULL);
    }

    float total_ms_sum = 0;
    float gpu_ms_sum = 0;
    float best_total = 1e9;
    float worst_total = 0;

    for (int r = 0; r < runs; r++) {
        uint8_t digest[32];
        stage_timing_t timing;
        char nonce[64];
        snprintf(nonce, sizeof(nonce), "bench-%d-%d", r, (int)time(NULL));

        int rc = compute_stage_gpu(nonce, (uint32_t)r, 1,
                                   M, N, K, mix_rounds, digest, &timing);
        if (rc != 0) {
            printf("  Run %d: FAILED (rc=%d)\n", r, rc);
            continue;
        }

        char label[32];
        snprintf(label, sizeof(label), "Run %d:", r);
        print_timing(label, M, N, K, mix_rounds, &timing);

        total_ms_sum += timing.total_ms;
        gpu_ms_sum += timing.total_gpu_ms;
        if (timing.total_ms < best_total) best_total = timing.total_ms;
        if (timing.total_ms > worst_total) worst_total = timing.total_ms;
    }

    printf("\n=== Summary (%d runs) ===\n", runs);
    printf("  Avg total:     %8.2f ms\n", total_ms_sum / runs);
    printf("  Avg GPU-only:  %8.2f ms\n", gpu_ms_sum / runs);
    printf("  Best total:    %8.2f ms\n", best_total);
    printf("  Worst total:   %8.2f ms\n", worst_total);
    printf("  Per-challenge (5 stages): %.2f ms\n", (total_ms_sum / runs) * 5);
}

static void cmd_bench_profiles(void) {
    printf("=== GPU Benchmark: All Profiles ===\n\n");

    /* Phase 2A profiles (original, small dimensions) */
    struct { const char *name; uint32_t M, N, K, r; } profiles[] = {
        { "Phase2A gpu-small",       4096, 4096, 8, 1 },
        { "Phase2A gpu-medium",      8192, 4096, 8, 2 },
        { "Phase2A gpu-large",       8192, 8192, 8, 2 },
        { "Phase2B gpu-small-v2",  262144, 4096, 8, 1 },
        { "Phase2B gpu-medium-v2", 524288, 4096, 8, 2 },
        { "Phase2B gpu-large-v2",  786432, 4096, 8, 2 },
    };
    int n_profiles = sizeof(profiles) / sizeof(profiles[0]);

    size_t free_mem, total_mem;
    CUDA_CHECK(cudaMemGetInfo(&free_mem, &total_mem));
    printf("GPU memory: %.2f GB free / %.2f GB total\n\n",
           free_mem / 1e9, total_mem / 1e9);

    for (int p = 0; p < n_profiles; p++) {
        uint64_t gpu_mem_needed = (uint64_t)profiles[p].M * profiles[p].N * 4
                                + (uint64_t)profiles[p].N * profiles[p].K * 4
                                + (uint64_t)profiles[p].M * profiles[p].K * 4 * 3;

        printf("--- %s (M=%u N=%u K=%u r=%u) ---\n",
               profiles[p].name, profiles[p].M, profiles[p].N,
               profiles[p].K, profiles[p].r);
        printf("  Working set: %.2f GB, GPU mem needed: %.2f GB\n",
               (uint64_t)profiles[p].M * profiles[p].N * 4 / 1e9,
               gpu_mem_needed / 1e9);

        if (gpu_mem_needed > free_mem) {
            printf("  SKIPPED — not enough GPU memory (need %.2f GB, have %.2f GB)\n\n",
                   gpu_mem_needed / 1e9, free_mem / 1e9);
            continue;
        }

        /* 3 runs per profile */
        float times[3];
        float gpu_times[3];
        for (int r = 0; r < 3; r++) {
            uint8_t digest[32];
            stage_timing_t timing;
            char nonce[64];
            snprintf(nonce, sizeof(nonce), "profile-%d-run-%d", p, r);

            int rc = compute_stage_gpu(nonce, (uint32_t)r, 1,
                                       profiles[p].M, profiles[p].N,
                                       profiles[p].K, profiles[p].r,
                                       digest, &timing);
            if (rc != 0) {
                printf("  Run %d: FAILED\n", r);
                times[r] = -1;
                gpu_times[r] = -1;
                continue;
            }
            times[r] = timing.total_ms;
            gpu_times[r] = timing.total_gpu_ms;

            if (r == 0) {
                print_timing("  Detail", profiles[p].M, profiles[p].N,
                             profiles[p].K, profiles[p].r, &timing);
            }
        }

        /* Median of 3 */
        float sorted[3];
        memcpy(sorted, times, sizeof(sorted));
        for (int i = 0; i < 2; i++)
            for (int j = i+1; j < 3; j++)
                if (sorted[j] < sorted[i]) { float t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t; }

        printf("  Median total: %.2f ms  (per challenge: %.2f ms)\n",
               sorted[1], sorted[1] * 5);
        printf("\n");
    }
}

/* ======================== GPU info ======================== */

static void cmd_info(void) {
    int device;
    CUDA_CHECK(cudaGetDevice(&device));

    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));

    size_t free_mem, total_mem;
    CUDA_CHECK(cudaMemGetInfo(&free_mem, &total_mem));

    printf("=== GPU Information ===\n");
    printf("  Device:            %s\n", prop.name);
    printf("  Compute cap:       %d.%d\n", prop.major, prop.minor);
    printf("  SMs:               %d\n", prop.multiProcessorCount);
    printf("  Max threads/block: %d\n", prop.maxThreadsPerBlock);
    printf("  Max grid dim x:    %d\n", prop.maxGridSize[0]);
    printf("  VRAM total:        %.2f GB (%zu MiB)\n",
           total_mem / 1e9, total_mem / (1024*1024));
    printf("  VRAM free:         %.2f GB (%zu MiB)\n",
           free_mem / 1e9, free_mem / (1024*1024));
    printf("  Clock rate:        %d MHz\n", prop.clockRate / 1000);
    printf("  Memory clock:      %d MHz\n", prop.memoryClockRate / 1000);
    printf("  Memory bus:        %d bit\n", prop.memoryBusWidth);
    printf("  L2 cache:          %d KB\n", prop.l2CacheSize / 1024);
    printf("  Warp size:         %d\n", prop.warpSize);
    printf("  Can map host mem:  %s\n", prop.canMapHostMemory ? "yes" : "no");

    /* Theoretical memory bandwidth */
    double bw_gbps = 2.0 * prop.memoryClockRate * 1e3 * (prop.memoryBusWidth / 8) / 1e9;
    printf("  Theo. mem BW:      %.1f GB/s\n", bw_gbps);

    printf("\n=== Phase 2B Working Set Feasibility ===\n");
    struct { const char *name; uint64_t ws_bytes; } checks[] = {
        { "gpu-small-v2  (4 GB)",   (uint64_t)262144 * 4096 * 4 },
        { "gpu-medium-v2 (8 GB)",   (uint64_t)524288 * 4096 * 4 },
        { "gpu-large-v2  (12 GB)",  (uint64_t)786432 * 4096 * 4 },
    };
    for (int i = 0; i < 3; i++) {
        uint64_t total_needed = checks[i].ws_bytes
                              + (uint64_t)4096 * 8 * 4  /* X */
                              + (uint64_t)(checks[i].ws_bytes / (4096*4)) * 8 * 4 * 3; /* Y+bufs */
        printf("  %s: need %.2f GB, %s\n",
               checks[i].name, total_needed / 1e9,
               total_needed <= free_mem ? "FITS" : "WON'T FIT (free VRAM first)");
    }
}

/* ======================== Digest mode (mirrors C99 reference interface) ======================== */

/**
 * --digest rootNonce classId stageIndex M N K mixRounds
 * Output: stage_nonce=<hex>\ndigest=<hex>\n
 * Identical interface to the C99 reference binary, but runs GEMM/mix on GPU.
 */
static int cmd_digest(const char *root_nonce, uint32_t class_id,
                      uint32_t stage_index, uint32_t M, uint32_t N,
                      uint32_t K, uint32_t mix_rounds) {
    uint8_t stage_nonce[32];
    derive_stage_nonce(root_nonce, stage_index, stage_nonce);

    char nonce_hex[65];
    hex_encode(stage_nonce, 32, nonce_hex);

    uint8_t digest[32];
    stage_timing_t timing;
    int rc = compute_stage_gpu_core(stage_nonce, stage_index, class_id,
                                    M, N, K, mix_rounds, digest, &timing);
    if (rc != 0) {
        fprintf(stderr, "compute_stage_gpu_core failed (rc=%d)\n", rc);
        return 1;
    }

    char digest_hex[65];
    hex_encode(digest, 32, digest_hex);

    printf("stage_nonce=%s\n", nonce_hex);
    printf("digest=%s\n", digest_hex);
    return 0;
}

/* ======================== Compute mode (staging worker) ======================== */

/**
 * --compute stageNonceHex classId stageIndex M N K mixRounds
 * Output: digest=<hex>\ngpu_ms=<float>\ntotal_ms=<float>\n
 * Takes pre-derived stage_nonce as 64-char hex. Used by the staging GPU worker
 * to compute challenge digests through the protocol without knowing root_nonce.
 */
static int cmd_compute(const char *nonce_hex, uint32_t class_id,
                       uint32_t stage_index, uint32_t M, uint32_t N,
                       uint32_t K, uint32_t mix_rounds) {
    uint8_t stage_nonce[32];
    if (hex_decode(nonce_hex, stage_nonce, 32) != 0) {
        fprintf(stderr, "Invalid stage_nonce hex (need exactly 64 hex chars)\n");
        return 1;
    }

    uint8_t digest[32];
    stage_timing_t timing;
    int rc = compute_stage_gpu_core(stage_nonce, stage_index, class_id,
                                    M, N, K, mix_rounds, digest, &timing);
    if (rc != 0) {
        fprintf(stderr, "compute_stage_gpu_core failed (rc=%d)\n", rc);
        return 1;
    }

    char digest_hex[65];
    hex_encode(digest, 32, digest_hex);

    printf("digest=%s\n", digest_hex);
    printf("gpu_ms=%.2f\n", timing.total_gpu_ms);
    printf("total_ms=%.2f\n", timing.total_ms);
    return 0;
}

/**
 * --serve mode: persistent GPU process for staging calibration.
 *
 * Initializes CUDA and pre-allocates GPU memory ONCE, then reads
 * compute requests from stdin, one per line:
 *   NONCE_HEX CID SI M N K MR
 *
 * For each line, outputs:
 *   digest=<hex>
 *   gpu_ms=<float>
 *   total_ms=<float>
 *   DONE
 *
 * Exits when stdin closes (EOF) or on "EXIT" line.
 *
 * This eliminates the ~3 minute CUDA context + memory allocation
 * overhead that occurs per-invocation on WSL2.
 */
static int cmd_serve(uint32_t max_M, uint32_t max_N, uint32_t max_K) {
    fprintf(stderr, "serve: initializing CUDA and pre-allocating for M=%u N=%u K=%u...\n",
            max_M, max_N, max_K);

    /* Force CUDA context initialization */
    CUDA_CHECK(cudaSetDevice(0));
    CUDA_CHECK(cudaFree(0));

    uint64_t max_count_A = (uint64_t)max_M * max_N;
    uint64_t max_count_X = (uint64_t)max_N * max_K;
    uint64_t max_count_Y = (uint64_t)max_M * max_K;

    uint32_t *d_A, *d_X, *d_Y, *d_buf_a, *d_buf_b;
    CUDA_CHECK(cudaMalloc(&d_A, (size_t)max_count_A * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_X, (size_t)max_count_X * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_Y, (size_t)max_count_Y * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_buf_a, (size_t)max_count_Y * sizeof(uint32_t)));
    CUDA_CHECK(cudaMalloc(&d_buf_b, (size_t)max_count_Y * sizeof(uint32_t)));

    fprintf(stderr, "serve: READY — reading from stdin\n");
    fflush(stderr);
    printf("READY\n");
    fflush(stdout);

    char line[512];
    while (fgets(line, sizeof(line), stdin)) {
        /* Strip newline */
        line[strcspn(line, "\r\n")] = '\0';

        if (strcmp(line, "EXIT") == 0) break;
        if (line[0] == '\0') continue;

        /* Parse: NONCE_HEX CID SI M N K MR */
        char nonce_hex[128];
        uint32_t cid, si, M, N, K, mr;
        if (sscanf(line, "%127s %u %u %u %u %u %u",
                   nonce_hex, &cid, &si, &M, &N, &K, &mr) != 7) {
            fprintf(stderr, "serve: bad input: %s\n", line);
            printf("ERROR bad_input\n");
            fflush(stdout);
            continue;
        }

        if (M > max_M || N > max_N || K > max_K) {
            fprintf(stderr, "serve: dimensions exceed pre-allocated max\n");
            printf("ERROR dimensions_exceed_max\n");
            fflush(stdout);
            continue;
        }

        uint8_t stage_nonce[32];
        if (hex_decode(nonce_hex, stage_nonce, 32) != 0) {
            fprintf(stderr, "serve: invalid nonce hex\n");
            printf("ERROR bad_nonce\n");
            fflush(stdout);
            continue;
        }

        /* Compute using pre-allocated buffers */
        uint64_t count_A = (uint64_t)M * N;
        uint64_t count_X = (uint64_t)N * K;
        uint64_t count_Y = (uint64_t)M * K;

        uint64_t base_A = stream_base_host(stage_nonce, 0u);
        uint64_t base_X = stream_base_host(stage_nonce, 1u);
        uint64_t base_mask = stream_base_host(stage_nonce, 2u);

        cudaEvent_t ev_start, ev_fill_A, ev_fill_X, ev_gemm, ev_mix, ev_d2h;
        CUDA_CHECK(cudaEventCreate(&ev_start));
        CUDA_CHECK(cudaEventCreate(&ev_fill_A));
        CUDA_CHECK(cudaEventCreate(&ev_fill_X));
        CUDA_CHECK(cudaEventCreate(&ev_gemm));
        CUDA_CHECK(cudaEventCreate(&ev_mix));
        CUDA_CHECK(cudaEventCreate(&ev_d2h));

        int threads = 256;
        CUDA_CHECK(cudaEventRecord(ev_start));

        { int blocks = (int)((count_A + threads - 1) / threads);
          fill_tensor_kernel<<<blocks, threads>>>(d_A, count_A, base_A, SPLITMIX_GAMMA); }
        CUDA_CHECK(cudaEventRecord(ev_fill_A));

        { int blocks = (int)((count_X + threads - 1) / threads);
          fill_tensor_kernel<<<blocks, threads>>>(d_X, count_X, base_X, SPLITMIX_GAMMA); }
        CUDA_CHECK(cudaEventRecord(ev_fill_X));

        { int blocks = (int)((M + threads - 1) / threads);
          gemm_kernel<<<blocks, threads>>>(d_A, d_X, M, N, K, d_Y); }
        CUDA_CHECK(cudaEventRecord(ev_gemm));

        { uint32_t *src = d_Y, *dst = d_buf_a;
          CUDA_CHECK(cudaMemcpy(d_buf_a, d_Y, (size_t)count_Y * sizeof(uint32_t),
                                cudaMemcpyDeviceToDevice));
          src = d_buf_a; dst = d_buf_b;
          int mix_blocks = (int)((count_Y + threads - 1) / threads);
          for (uint32_t round = 0; round < mr; round++) {
              uint64_t perm_a, perm_b;
              derive_perm_params(stage_nonce, round, count_Y, &perm_a, &perm_b);
              uint64_t round_mask_base = base_mask + (uint64_t)round * count_Y * SPLITMIX_GAMMA;
              mix_kernel<<<mix_blocks, threads>>>(src, dst, count_Y, perm_a, perm_b,
                                                   round_mask_base, SPLITMIX_GAMMA);
              uint32_t *tmp = src; src = dst; dst = tmp;
          }
          CUDA_CHECK(cudaMemcpy(d_Y, src, (size_t)count_Y * sizeof(uint32_t),
                                cudaMemcpyDeviceToDevice));
        }
        CUDA_CHECK(cudaEventRecord(ev_mix));

        uint32_t *h_Z = (uint32_t *)malloc((size_t)count_Y * sizeof(uint32_t));
        if (!h_Z) { fprintf(stderr, "serve: malloc failed\n"); break; }
        CUDA_CHECK(cudaMemcpy(h_Z, d_Y, (size_t)count_Y * sizeof(uint32_t),
                              cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaEventRecord(ev_d2h));
        CUDA_CHECK(cudaEventSynchronize(ev_d2h));

        uint8_t digest[32];
        struct timespec ts_start, ts_end;
        clock_gettime(CLOCK_MONOTONIC, &ts_start);
        compute_final_digest(cid, si, M, N, K, mr, stage_nonce, h_Z, digest);
        clock_gettime(CLOCK_MONOTONIC, &ts_end);

        float total_gpu_ms, d2h_ms, digest_ms;
        CUDA_CHECK(cudaEventElapsedTime(&total_gpu_ms, ev_start, ev_mix));
        CUDA_CHECK(cudaEventElapsedTime(&d2h_ms, ev_mix, ev_d2h));
        digest_ms = (float)((ts_end.tv_sec - ts_start.tv_sec) * 1000.0 +
                             (ts_end.tv_nsec - ts_start.tv_nsec) / 1e6);
        float total_ms = total_gpu_ms + d2h_ms + digest_ms;

        char digest_hex[65];
        hex_encode(digest, 32, digest_hex);

        printf("digest=%s\n", digest_hex);
        printf("gpu_ms=%.2f\n", total_gpu_ms);
        printf("total_ms=%.2f\n", total_ms);
        printf("DONE\n");
        fflush(stdout);

        free(h_Z);
        cudaEventDestroy(ev_start);
        cudaEventDestroy(ev_fill_A);
        cudaEventDestroy(ev_fill_X);
        cudaEventDestroy(ev_gemm);
        cudaEventDestroy(ev_mix);
        cudaEventDestroy(ev_d2h);
    }

    cudaFree(d_A);
    cudaFree(d_X);
    cudaFree(d_Y);
    cudaFree(d_buf_a);
    cudaFree(d_buf_b);

    fprintf(stderr, "serve: shutdown\n");
    return 0;
}

/* ======================== Main ======================== */

static void print_usage(const char *argv0) {
    fprintf(stderr,
        "Usage:\n"
        "  %s --selftest                           Golden vector verification\n"
        "  %s --bench M N K R [runs]               Benchmark (default 5 runs)\n"
        "  %s --bench-profiles                     All Phase 2A+2B profiles\n"
        "  %s --info                               GPU information\n"
        "  %s --digest ROOT_NONCE CID SI M N K MR  Compute digest (mirrors C99 ref)\n"
        "  %s --compute NONCE_HEX CID SI M N K MR  Compute from stage_nonce (worker)\n"
        "  %s --serve M N K                         Persistent mode (reads from stdin)\n",
        argv0, argv0, argv0, argv0, argv0, argv0, argv0);
}

int main(int argc, char **argv) {
    if (argc < 2) { print_usage(argv[0]); return 1; }

    if (strcmp(argv[1], "--selftest") == 0)
        return cmd_selftest();

    if (strcmp(argv[1], "--info") == 0) {
        cmd_info();
        return 0;
    }

    if (strcmp(argv[1], "--digest") == 0 && argc >= 9) {
        return cmd_digest(argv[2],
                          (uint32_t)strtoul(argv[3], NULL, 10),
                          (uint32_t)strtoul(argv[4], NULL, 10),
                          (uint32_t)strtoul(argv[5], NULL, 10),
                          (uint32_t)strtoul(argv[6], NULL, 10),
                          (uint32_t)strtoul(argv[7], NULL, 10),
                          (uint32_t)strtoul(argv[8], NULL, 10));
    }

    if (strcmp(argv[1], "--compute") == 0 && argc >= 9) {
        return cmd_compute(argv[2],
                           (uint32_t)strtoul(argv[3], NULL, 10),
                           (uint32_t)strtoul(argv[4], NULL, 10),
                           (uint32_t)strtoul(argv[5], NULL, 10),
                           (uint32_t)strtoul(argv[6], NULL, 10),
                           (uint32_t)strtoul(argv[7], NULL, 10),
                           (uint32_t)strtoul(argv[8], NULL, 10));
    }

    if (strcmp(argv[1], "--bench") == 0 && argc >= 6) {
        uint32_t M = (uint32_t)strtoul(argv[2], NULL, 10);
        uint32_t N = (uint32_t)strtoul(argv[3], NULL, 10);
        uint32_t K = (uint32_t)strtoul(argv[4], NULL, 10);
        uint32_t R = (uint32_t)strtoul(argv[5], NULL, 10);
        int runs = (argc >= 7) ? atoi(argv[6]) : 5;
        cmd_bench(M, N, K, R, runs);
        return 0;
    }

    if (strcmp(argv[1], "--bench-profiles") == 0) {
        cmd_bench_profiles();
        return 0;
    }

    if (strcmp(argv[1], "--serve") == 0 && argc >= 5) {
        return cmd_serve((uint32_t)strtoul(argv[2], NULL, 10),
                         (uint32_t)strtoul(argv[3], NULL, 10),
                         (uint32_t)strtoul(argv[4], NULL, 10));
    }

    print_usage(argv[0]);
    return 1;
}
