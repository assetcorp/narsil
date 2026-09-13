(module
  (memory (export "memory") 1)

  ;; dot_product(ptr_a: i32, ptr_b: i32, len: i32) -> f32
  ;; Computes sum of a[i] * b[i] using f32x4 SIMD lanes.
  ;; Pointers are byte offsets into linear memory.
  ;; len is the number of f32 elements (not bytes).
  (func (export "dot_product") (param $a i32) (param $b i32) (param $len i32) (result f32)
    (local $i i32)
    (local $acc v128)
    (local $sum f32)
    (local $simd_end i32)

    (local.set $simd_end (i32.and (local.get $len) (i32.const -4)))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (local.set $i (i32.const 0))

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

  (func (export "osq_dot_planes") (param $doc i32) (param $query i32) (param $plane_bytes i32) (param $doc_bits i32) (param $query_bits i32) (result i32)
    (local $j i32)
    (local $p i32)
    (local $total i32)
    (local $bits i32)
    (local $a i32)
    (local $b i32)
    (local $i i32)
    (local $simd_end i32)
    (local $acc v128)

    (local.set $total (i32.const 0))
    (local.set $simd_end (i32.and (local.get $plane_bytes) (i32.const -16)))
    (local.set $j (i32.const 0))

    (block $jbrk
      (loop $jlp
        (br_if $jbrk (i32.ge_u (local.get $j) (local.get $doc_bits)))
        (local.set $a (i32.add (local.get $doc) (i32.mul (local.get $j) (local.get $plane_bytes))))
        (local.set $p (i32.const 0))
        (block $pbrk
          (loop $plp
            (br_if $pbrk (i32.ge_u (local.get $p) (local.get $query_bits)))
            (local.set $b (i32.add (local.get $query) (i32.mul (local.get $p) (local.get $plane_bytes))))
            (local.set $acc (i32x4.splat (i32.const 0)))
            (local.set $i (i32.const 0))
            (block $ibrk
              (loop $ilp
                (br_if $ibrk (i32.ge_u (local.get $i) (local.get $simd_end)))
                (local.set $acc
                  (i32x4.add
                    (local.get $acc)
                    (i32x4.extadd_pairwise_i16x8_u
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
                )
                (local.set $i (i32.add (local.get $i) (i32.const 16)))
                (br $ilp)
              )
            )
            (local.set $bits
              (i32.add
                (i32.add (i32x4.extract_lane 0 (local.get $acc)) (i32x4.extract_lane 1 (local.get $acc)))
                (i32.add (i32x4.extract_lane 2 (local.get $acc)) (i32x4.extract_lane 3 (local.get $acc)))
              )
            )
            (block $rbrk
              (loop $rlp
                (br_if $rbrk (i32.ge_u (local.get $i) (local.get $plane_bytes)))
                (local.set $bits
                  (i32.add
                    (local.get $bits)
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
            (local.set $total
              (i32.add (local.get $total) (i32.shl (local.get $bits) (i32.add (local.get $j) (local.get $p))))
            )
            (local.set $p (i32.add (local.get $p) (i32.const 1)))
            (br $plp)
          )
        )
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $jlp)
      )
    )

    (local.get $total)
  )

)
