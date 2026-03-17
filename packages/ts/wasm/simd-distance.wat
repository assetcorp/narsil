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

)
