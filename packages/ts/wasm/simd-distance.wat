(module
  (memory (export "memory") 1)

  ;; dot_product(ptr_a: i32, ptr_b: i32, len: i32) -> f32
  ;; Computes sum of a[i] * b[i] using f32x4 SIMD lanes.
  ;; Pointers are byte offsets into linear memory.
  ;; len is the number of f32 elements (not bytes).
  (func (export "dot_product") (param $a i32) (param $b i32) (param $len i32) (result f32)
    (local $i i32)
    (local $acc v128)
    (local $acc1 v128)
    (local $acc2 v128)
    (local $acc3 v128)
    (local $sum f32)
    (local $wide_end i32)
    (local $simd_end i32)
    (local $pa i32)
    (local $pb i32)

    (local.set $wide_end (i32.and (local.get $len) (i32.const -16)))
    (local.set $simd_end (i32.and (local.get $len) (i32.const -4)))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))

    (block $wbrk
      (loop $wlp
        (br_if $wbrk (i32.ge_u (local.get $i) (local.get $wide_end)))
        (local.set $pa (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $pb (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (v128.load (local.get $pa)) (v128.load (local.get $pb)))))
        (local.set $acc1 (f32x4.add (local.get $acc1) (f32x4.mul (v128.load offset=16 (local.get $pa)) (v128.load offset=16 (local.get $pb)))))
        (local.set $acc2 (f32x4.add (local.get $acc2) (f32x4.mul (v128.load offset=32 (local.get $pa)) (v128.load offset=32 (local.get $pb)))))
        (local.set $acc3 (f32x4.add (local.get $acc3) (f32x4.mul (v128.load offset=48 (local.get $pa)) (v128.load offset=48 (local.get $pb)))))
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $wlp)
      )
    )

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $acc
          (f32x4.add
            (local.get $acc)
            (f32x4.mul
              (v128.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
              (v128.load (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2))))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $lp)
      )
    )

    (local.set $acc
      (f32x4.add
        (f32x4.add (local.get $acc) (local.get $acc1))
        (f32x4.add (local.get $acc2) (local.get $acc3))
      )
    )

    (local.set $sum
      (f32.add
        (f32.add
          (f32x4.extract_lane 0 (local.get $acc))
          (f32x4.extract_lane 1 (local.get $acc))
        )
        (f32.add
          (f32x4.extract_lane 2 (local.get $acc))
          (f32x4.extract_lane 3 (local.get $acc))
        )
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $sum
          (f32.add
            (local.get $sum)
            (f32.mul
              (f32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
              (f32.load (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2))))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $sum)
  )

  ;; magnitude(ptr: i32, len: i32) -> f32
  ;; Computes sqrt(sum of v[i]^2).
  (func (export "magnitude") (param $a i32) (param $len i32) (result f32)
    (local $i i32)
    (local $acc v128)
    (local $v v128)
    (local $sum f32)
    (local $simd_end i32)

    (local.set $simd_end (i32.and (local.get $len) (i32.const -4)))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $v
          (v128.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
        )
        (local.set $acc
          (f32x4.add (local.get $acc) (f32x4.mul (local.get $v) (local.get $v)))
        )
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $lp)
      )
    )

    (local.set $sum
      (f32.add
        (f32.add
          (f32x4.extract_lane 0 (local.get $acc))
          (f32x4.extract_lane 1 (local.get $acc))
        )
        (f32.add
          (f32x4.extract_lane 2 (local.get $acc))
          (f32x4.extract_lane 3 (local.get $acc))
        )
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $sum
          (f32.add
            (local.get $sum)
            (f32.mul
              (f32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
              (f32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (f32.sqrt (local.get $sum))
  )

  ;; squared_euclidean_distance(ptr_a: i32, ptr_b: i32, len: i32) -> f32
  ;; Computes sum of (a[i] - b[i])^2.
  (func $squared_euclidean_distance (export "squared_euclidean_distance") (param $a i32) (param $b i32) (param $len i32) (result f32)
    (local $i i32)
    (local $acc v128)
    (local $diff v128)
    (local $sum f32)
    (local $simd_end i32)
    (local $d f32)

    (local.set $simd_end (i32.and (local.get $len) (i32.const -4)))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $diff
          (f32x4.sub
            (v128.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
            (v128.load (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2))))
          )
        )
        (local.set $acc
          (f32x4.add (local.get $acc) (f32x4.mul (local.get $diff) (local.get $diff)))
        )
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $lp)
      )
    )

    (local.set $sum
      (f32.add
        (f32.add
          (f32x4.extract_lane 0 (local.get $acc))
          (f32x4.extract_lane 1 (local.get $acc))
        )
        (f32.add
          (f32x4.extract_lane 2 (local.get $acc))
          (f32x4.extract_lane 3 (local.get $acc))
        )
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $d
          (f32.sub
            (f32.load (i32.add (local.get $a) (i32.shl (local.get $i) (i32.const 2))))
            (f32.load (i32.add (local.get $b) (i32.shl (local.get $i) (i32.const 2))))
          )
        )
        (local.set $sum
          (f32.add (local.get $sum) (f32.mul (local.get $d) (local.get $d)))
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $sum)
  )

  ;; euclidean_distance(ptr_a: i32, ptr_b: i32, len: i32) -> f32
  ;; Computes sqrt(sum of (a[i] - b[i])^2).
  (func (export "euclidean_distance") (param $a i32) (param $b i32) (param $len i32) (result f32)
    (f32.sqrt
      (call $squared_euclidean_distance (local.get $a) (local.get $b) (local.get $len))
    )
  )

  ;; dot_u8(ptr_a: i32, ptr_b: i32, len: i32) -> i32
  ;; Integer dot product of two uint8 vectors. len is the number of u8 elements.
  ;; Processes 16 bytes per SIMD step via unsigned widen + i32x4.dot_i16x8_s.
  (func (export "dot_u8") (param $a i32) (param $b i32) (param $len i32) (result i32)
    (local $i i32)
    (local $acc v128)
    (local $va v128)
    (local $vb v128)
    (local $sum i32)
    (local $simd_end i32)

    (local.set $simd_end (i32.and (local.get $len) (i32.const -16)))
    (local.set $acc (i32x4.splat (i32.const 0)))
    (local.set $i (i32.const 0))

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $va (v128.load (i32.add (local.get $a) (local.get $i))))
        (local.set $vb (v128.load (i32.add (local.get $b) (local.get $i))))
        (local.set $acc
          (i32x4.add
            (local.get $acc)
            (i32x4.dot_i16x8_s
              (i16x8.extend_low_i8x16_u (local.get $va))
              (i16x8.extend_low_i8x16_u (local.get $vb))
            )
          )
        )
        (local.set $acc
          (i32x4.add
            (local.get $acc)
            (i32x4.dot_i16x8_s
              (i16x8.extend_high_i8x16_u (local.get $va))
              (i16x8.extend_high_i8x16_u (local.get $vb))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $lp)
      )
    )

    (local.set $sum
      (i32.add
        (i32.add (i32x4.extract_lane 0 (local.get $acc)) (i32x4.extract_lane 1 (local.get $acc)))
        (i32.add (i32x4.extract_lane 2 (local.get $acc)) (i32x4.extract_lane 3 (local.get $acc)))
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $sum
          (i32.add
            (local.get $sum)
            (i32.mul
              (i32.load8_u (i32.add (local.get $a) (local.get $i)))
              (i32.load8_u (i32.add (local.get $b) (local.get $i)))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $sum)
  )

  ;; sqdist_u8(ptr_a: i32, ptr_b: i32, len: i32) -> i32
  ;; Integer sum of squared differences of two uint8 vectors.
  (func (export "sqdist_u8") (param $a i32) (param $b i32) (param $len i32) (result i32)
    (local $i i32)
    (local $acc v128)
    (local $va v128)
    (local $vb v128)
    (local $dl v128)
    (local $dh v128)
    (local $sum i32)
    (local $d i32)
    (local $simd_end i32)

    (local.set $simd_end (i32.and (local.get $len) (i32.const -16)))
    (local.set $acc (i32x4.splat (i32.const 0)))
    (local.set $i (i32.const 0))

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $va (v128.load (i32.add (local.get $a) (local.get $i))))
        (local.set $vb (v128.load (i32.add (local.get $b) (local.get $i))))
        (local.set $dl
          (i16x8.sub
            (i16x8.extend_low_i8x16_u (local.get $va))
            (i16x8.extend_low_i8x16_u (local.get $vb))
          )
        )
        (local.set $dh
          (i16x8.sub
            (i16x8.extend_high_i8x16_u (local.get $va))
            (i16x8.extend_high_i8x16_u (local.get $vb))
          )
        )
        (local.set $acc (i32x4.add (local.get $acc) (i32x4.dot_i16x8_s (local.get $dl) (local.get $dl))))
        (local.set $acc (i32x4.add (local.get $acc) (i32x4.dot_i16x8_s (local.get $dh) (local.get $dh))))
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $lp)
      )
    )

    (local.set $sum
      (i32.add
        (i32.add (i32x4.extract_lane 0 (local.get $acc)) (i32x4.extract_lane 1 (local.get $acc)))
        (i32.add (i32x4.extract_lane 2 (local.get $acc)) (i32x4.extract_lane 3 (local.get $acc)))
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $d
          (i32.sub
            (i32.load8_u (i32.add (local.get $a) (local.get $i)))
            (i32.load8_u (i32.add (local.get $b) (local.get $i)))
          )
        )
        (local.set $sum (i32.add (local.get $sum) (i32.mul (local.get $d) (local.get $d))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $sum)
  )

  (func $sum_of_u16_lanes (param $lanes v128) (result i32)
    (local $wide v128)
    (local.set $wide (i32x4.extadd_pairwise_i16x8_u (local.get $lanes)))
    (i32.add
      (i32.add (i32x4.extract_lane 0 (local.get $wide)) (i32x4.extract_lane 1 (local.get $wide)))
      (i32.add (i32x4.extract_lane 2 (local.get $wide)) (i32x4.extract_lane 3 (local.get $wide)))
    )
  )

  (func $osq_dot_one_bit_query (param $doc i32) (param $planes i32) (param $plane_bytes i32) (result i32)
    (local $i i32)
    (local $p i32)
    (local $simd_end i32)
    (local $span_end i32)
    (local $total i32)
    (local $p1 i32)
    (local $p2 i32)
    (local $p3 i32)
    (local $d v128)
    (local $weighted v128)
    (local $acc v128)
    (local $doc_byte i32)

    (local.set $p1 (i32.add (local.get $planes) (local.get $plane_bytes)))
    (local.set $p2 (i32.add (local.get $p1) (local.get $plane_bytes)))
    (local.set $p3 (i32.add (local.get $p2) (local.get $plane_bytes)))
    (local.set $simd_end (i32.and (local.get $plane_bytes) (i32.const -16)))

    (block $brk
      (loop $spans
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $span_end (i32.add (local.get $i) (i32.const 2048)))
        (if (i32.gt_u (local.get $span_end) (local.get $simd_end)) (then (local.set $span_end (local.get $simd_end))))
        (local.set $acc (i16x8.splat (i32.const 0)))
        (loop $lp
          (local.set $d (v128.load (i32.add (local.get $doc) (local.get $i))))
          (local.set $weighted (i8x16.popcnt (v128.and (local.get $d) (v128.load (i32.add (local.get $p3) (local.get $i))))))
          (local.set $weighted (i8x16.add (i8x16.add (local.get $weighted) (local.get $weighted)) (i8x16.popcnt (v128.and (local.get $d) (v128.load (i32.add (local.get $p2) (local.get $i)))))))
          (local.set $weighted (i8x16.add (i8x16.add (local.get $weighted) (local.get $weighted)) (i8x16.popcnt (v128.and (local.get $d) (v128.load (i32.add (local.get $p1) (local.get $i)))))))
          (local.set $weighted (i8x16.add (i8x16.add (local.get $weighted) (local.get $weighted)) (i8x16.popcnt (v128.and (local.get $d) (v128.load (i32.add (local.get $planes) (local.get $i)))))))
          (local.set $acc (i16x8.add (local.get $acc) (i16x8.extadd_pairwise_i8x16_u (local.get $weighted))))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br_if $lp (i32.lt_u (local.get $i) (local.get $span_end)))
        )
        (local.set $total (i32.add (local.get $total) (call $sum_of_u16_lanes (local.get $acc))))
        (br $spans)
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $plane_bytes)))
        (local.set $doc_byte (i32.load8_u (i32.add (local.get $doc) (local.get $i))))
        (local.set $p (i32.const 0))
        (block $qbrk
          (loop $qlp
            (br_if $qbrk (i32.ge_u (local.get $p) (i32.const 4)))
            (local.set $total
              (i32.add
                (local.get $total)
                (i32.shl
                  (i32.popcnt
                    (i32.and
                      (local.get $doc_byte)
                      (i32.load8_u (i32.add (i32.add (local.get $planes) (i32.mul (local.get $plane_bytes) (local.get $p))) (local.get $i)))
                    )
                  )
                  (local.get $p)
                )
              )
            )
            (local.set $p (i32.add (local.get $p) (i32.const 1)))
            (br $qlp)
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $total)
  )

  (func $osq_dot_two_bit_query (param $doc i32) (param $levels i32) (param $stream_bytes i32) (result i32)
    (local $i i32)
    (local $k i32)
    (local $simd_end i32)
    (local $span_end i32)
    (local $total i32)
    (local $l1 i32)
    (local $l2 i32)
    (local $l3 i32)
    (local $d v128)
    (local $d0 v128)
    (local $d1 v128)
    (local $d2 v128)
    (local $d3 v128)
    (local $q v128)
    (local $two_bits v128)
    (local $acc v128)
    (local $doc_byte i32)

    (local.set $l1 (i32.add (local.get $levels) (local.get $stream_bytes)))
    (local.set $l2 (i32.add (local.get $l1) (local.get $stream_bytes)))
    (local.set $l3 (i32.add (local.get $l2) (local.get $stream_bytes)))
    (local.set $two_bits (i8x16.splat (i32.const 3)))
    (local.set $simd_end (i32.and (local.get $stream_bytes) (i32.const -16)))

    (block $brk
      (loop $spans
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $span_end (i32.add (local.get $i) (i32.const 2048)))
        (if (i32.gt_u (local.get $span_end) (local.get $simd_end)) (then (local.set $span_end (local.get $simd_end))))
        (local.set $acc (i16x8.splat (i32.const 0)))
        (loop $lp
          (local.set $d (v128.load (i32.add (local.get $doc) (local.get $i))))
          (local.set $d0 (v128.and (local.get $d) (local.get $two_bits)))
          (local.set $d1 (v128.and (i8x16.shr_u (local.get $d) (i32.const 2)) (local.get $two_bits)))
          (local.set $d2 (v128.and (i8x16.shr_u (local.get $d) (i32.const 4)) (local.get $two_bits)))
          (local.set $d3 (i8x16.shr_u (local.get $d) (i32.const 6)))
          (local.set $q (v128.load (i32.add (local.get $levels) (local.get $i))))
          (local.set $acc (i16x8.add (local.get $acc) (i16x8.add (i16x8.extmul_low_i8x16_u (local.get $d0) (local.get $q)) (i16x8.extmul_high_i8x16_u (local.get $d0) (local.get $q)))))
          (local.set $q (v128.load (i32.add (local.get $l1) (local.get $i))))
          (local.set $acc (i16x8.add (local.get $acc) (i16x8.add (i16x8.extmul_low_i8x16_u (local.get $d1) (local.get $q)) (i16x8.extmul_high_i8x16_u (local.get $d1) (local.get $q)))))
          (local.set $q (v128.load (i32.add (local.get $l2) (local.get $i))))
          (local.set $acc (i16x8.add (local.get $acc) (i16x8.add (i16x8.extmul_low_i8x16_u (local.get $d2) (local.get $q)) (i16x8.extmul_high_i8x16_u (local.get $d2) (local.get $q)))))
          (local.set $q (v128.load (i32.add (local.get $l3) (local.get $i))))
          (local.set $acc (i16x8.add (local.get $acc) (i16x8.add (i16x8.extmul_low_i8x16_u (local.get $d3) (local.get $q)) (i16x8.extmul_high_i8x16_u (local.get $d3) (local.get $q)))))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br_if $lp (i32.lt_u (local.get $i) (local.get $span_end)))
        )
        (local.set $total (i32.add (local.get $total) (call $sum_of_u16_lanes (local.get $acc))))
        (br $spans)
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $stream_bytes)))
        (local.set $doc_byte (i32.load8_u (i32.add (local.get $doc) (local.get $i))))
        (local.set $k (i32.const 0))
        (block $kbrk
          (loop $klp
            (br_if $kbrk (i32.ge_u (local.get $k) (i32.const 4)))
            (local.set $total
              (i32.add
                (local.get $total)
                (i32.mul
                  (i32.and (i32.shr_u (local.get $doc_byte) (i32.shl (local.get $k) (i32.const 1))) (i32.const 3))
                  (i32.load8_u (i32.add (i32.add (local.get $levels) (i32.mul (local.get $stream_bytes) (local.get $k))) (local.get $i)))
                )
              )
            )
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $klp)
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $total)
  )

  (func (export "osq_dot_bits") (param $doc i32) (param $staged i32) (param $code_bytes i32) (param $doc_bits i32) (result i32)
    (if (result i32) (i32.eq (local.get $doc_bits) (i32.const 2))
      (then (call $osq_dot_two_bit_query (local.get $doc) (local.get $staged) (local.get $code_bytes)))
      (else (call $osq_dot_one_bit_query (local.get $doc) (local.get $staged) (local.get $code_bytes)))
    )
  )

  (func $osq_dot_one_bit_pair (param $a i32) (param $b i32) (param $bytes i32) (result i32)
    (local $i i32)
    (local $simd_end i32)
    (local $span_end i32)
    (local $total i32)
    (local $acc v128)

    (local.set $simd_end (i32.and (local.get $bytes) (i32.const -16)))

    (block $brk
      (loop $spans
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $span_end (i32.add (local.get $i) (i32.const 2048)))
        (if (i32.gt_u (local.get $span_end) (local.get $simd_end)) (then (local.set $span_end (local.get $simd_end))))
        (local.set $acc (i16x8.splat (i32.const 0)))
        (loop $lp
          (local.set $acc
            (i16x8.add
              (local.get $acc)
              (i16x8.extadd_pairwise_i8x16_u
                (i8x16.popcnt
                  (v128.and
                    (v128.load (i32.add (local.get $a) (local.get $i)))
                    (v128.load (i32.add (local.get $b) (local.get $i)))
                  )
                )
              )
            )
          )
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br_if $lp (i32.lt_u (local.get $i) (local.get $span_end)))
        )
        (local.set $total (i32.add (local.get $total) (call $sum_of_u16_lanes (local.get $acc))))
        (br $spans)
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $bytes)))
        (local.set $total
          (i32.add
            (local.get $total)
            (i32.popcnt
              (i32.and
                (i32.load8_u (i32.add (local.get $a) (local.get $i)))
                (i32.load8_u (i32.add (local.get $b) (local.get $i)))
              )
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $total)
  )

  (func (export "osq_dot_bits_pair") (param $a i32) (param $b i32) (param $bytes i32) (param $bits i32) (result i32)
    (if (result i32) (i32.eq (local.get $bits) (i32.const 2))
      (then (call $osq_dot_two_bit_pair (local.get $a) (local.get $b) (local.get $bytes)))
      (else (call $osq_dot_one_bit_pair (local.get $a) (local.get $b) (local.get $bytes)))
    )
  )

  (func $osq_dot_two_bit_pair (param $a i32) (param $b i32) (param $bytes i32) (result i32)
    (local $i i32)
    (local $simd_end i32)
    (local $span_end i32)
    (local $total i32)
    (local $low_mask v128)
    (local $high_mask v128)
    (local $va v128)
    (local $vb v128)
    (local $same v128)
    (local $upper v128)
    (local $cross v128)
    (local $acc v128)
    (local $a_byte i32)
    (local $b_byte i32)
    (local $low_byte_mask i32)
    (local $high_byte_mask i32)

    (local.set $low_byte_mask (i32.const 85))
    (local.set $high_byte_mask (i32.const 85))
    (local.set $low_mask (i8x16.splat (i32.const 85)))
    (local.set $high_mask (i8x16.splat (i32.const 170)))
    (local.set $simd_end (i32.and (local.get $bytes) (i32.const -16)))

    (block $brk
      (loop $spans
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $span_end (i32.add (local.get $i) (i32.const 480)))
        (if (i32.gt_u (local.get $span_end) (local.get $simd_end)) (then (local.set $span_end (local.get $simd_end))))
        (local.set $acc (i8x16.splat (i32.const 0)))
        (local.set $upper (i8x16.splat (i32.const 0)))
        (local.set $cross (i8x16.splat (i32.const 0)))
        (loop $lp
          (local.set $va (v128.load (i32.add (local.get $a) (local.get $i))))
          (local.set $vb (v128.load (i32.add (local.get $b) (local.get $i))))
          (local.set $same (v128.and (local.get $va) (local.get $vb)))
          (local.set $acc (i8x16.add (local.get $acc) (i8x16.popcnt (local.get $same))))
          (local.set $upper (i8x16.add (local.get $upper) (i8x16.popcnt (v128.and (local.get $same) (local.get $high_mask)))))
          (local.set $cross
            (i8x16.add
              (local.get $cross)
              (i8x16.popcnt
                (v128.and
                  (local.get $va)
                  (v128.or
                    (v128.and (i8x16.shr_u (local.get $vb) (i32.const 1)) (local.get $low_mask))
                    (v128.and (i8x16.shl (local.get $vb) (i32.const 1)) (local.get $high_mask))
                  )
                )
              )
            )
          )
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br_if $lp (i32.lt_u (local.get $i) (local.get $span_end)))
        )
        (local.set $total
          (i32.add
            (local.get $total)
            (i32.add
              (call $sum_of_u16_lanes (i16x8.extadd_pairwise_i8x16_u (local.get $acc)))
              (i32.add
                (i32.mul (call $sum_of_u16_lanes (i16x8.extadd_pairwise_i8x16_u (local.get $upper))) (i32.const 3))
                (i32.shl (call $sum_of_u16_lanes (i16x8.extadd_pairwise_i8x16_u (local.get $cross))) (i32.const 1))
              )
            )
          )
        )
        (br $spans)
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $bytes)))
        (local.set $a_byte (i32.load8_u (i32.add (local.get $a) (local.get $i))))
        (local.set $b_byte (i32.load8_u (i32.add (local.get $b) (local.get $i))))
        (local.set $total
          (i32.add
            (local.get $total)
            (i32.add
              (i32.add
                (i32.popcnt (i32.and (i32.and (local.get $a_byte) (local.get $low_byte_mask)) (local.get $b_byte)))
                (i32.shl (i32.popcnt (i32.and (i32.and (local.get $a_byte) (local.get $low_byte_mask)) (i32.and (i32.shr_u (local.get $b_byte) (i32.const 1)) (local.get $high_byte_mask)))) (i32.const 1))
              )
              (i32.add
                (i32.shl (i32.popcnt (i32.and (i32.and (i32.shr_u (local.get $a_byte) (i32.const 1)) (local.get $high_byte_mask)) (i32.and (local.get $b_byte) (local.get $low_byte_mask)))) (i32.const 1))
                (i32.shl (i32.popcnt (i32.and (i32.and (i32.shr_u (local.get $a_byte) (i32.const 1)) (local.get $high_byte_mask)) (i32.and (i32.shr_u (local.get $b_byte) (i32.const 1)) (local.get $high_byte_mask)))) (i32.const 2))
              )
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $total)
  )

  (func (export "osq_dot_nibbles_4x4") (param $doc i32) (param $query i32) (param $bytes i32) (result i32)
    (local $i i32)
    (local $simd_end i32)
    (local $total i32)
    (local $d v128)
    (local $q v128)
    (local $dlo v128)
    (local $dhi v128)
    (local $qlo v128)
    (local $qhi v128)
    (local $mask v128)
    (local $acc v128)
    (local $query_byte i32)
    (local $doc_byte i32)

    (local.set $simd_end (i32.and (local.get $bytes) (i32.const -16)))
    (local.set $mask (i8x16.splat (i32.const 15)))
    (local.set $acc (i32x4.splat (i32.const 0)))
    (local.set $i (i32.const 0))

    (block $brk
      (loop $lp
        (br_if $brk (i32.ge_u (local.get $i) (local.get $simd_end)))
        (local.set $d (v128.load (i32.add (local.get $doc) (local.get $i))))
        (local.set $q (v128.load (i32.add (local.get $query) (local.get $i))))
        (local.set $dlo (v128.and (local.get $d) (local.get $mask)))
        (local.set $dhi (i8x16.shr_u (local.get $d) (i32.const 4)))
        (local.set $qlo (v128.and (local.get $q) (local.get $mask)))
        (local.set $qhi (i8x16.shr_u (local.get $q) (i32.const 4)))
        (local.set $acc
          (i32x4.add
            (local.get $acc)
            (i32x4.add
              (i32x4.extadd_pairwise_i16x8_u
                (i16x8.add
                  (i16x8.extmul_low_i8x16_u (local.get $dlo) (local.get $qlo))
                  (i16x8.extmul_low_i8x16_u (local.get $dhi) (local.get $qhi))
                )
              )
              (i32x4.extadd_pairwise_i16x8_u
                (i16x8.add
                  (i16x8.extmul_high_i8x16_u (local.get $dlo) (local.get $qlo))
                  (i16x8.extmul_high_i8x16_u (local.get $dhi) (local.get $qhi))
                )
              )
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $lp)
      )
    )

    (local.set $total
      (i32.add
        (i32.add (i32x4.extract_lane 0 (local.get $acc)) (i32x4.extract_lane 1 (local.get $acc)))
        (i32.add (i32x4.extract_lane 2 (local.get $acc)) (i32x4.extract_lane 3 (local.get $acc)))
      )
    )

    (block $rbrk
      (loop $rlp
        (br_if $rbrk (i32.ge_u (local.get $i) (local.get $bytes)))
        (local.set $doc_byte (i32.load8_u (i32.add (local.get $doc) (local.get $i))))
        (local.set $query_byte (i32.load8_u (i32.add (local.get $query) (local.get $i))))
        (local.set $total
          (i32.add
            (local.get $total)
            (i32.add
              (i32.mul (i32.and (local.get $doc_byte) (i32.const 15)) (i32.and (local.get $query_byte) (i32.const 15)))
              (i32.mul (i32.shr_u (local.get $doc_byte) (i32.const 4)) (i32.shr_u (local.get $query_byte) (i32.const 4)))
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rlp)
      )
    )

    (local.get $total)
  )

)
