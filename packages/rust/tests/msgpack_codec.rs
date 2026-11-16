use narsil::{ErrorCode, Map, Value, decode_msgpack, encode_msgpack};

#[test]
fn a_feed_message_encodes_to_the_bytes_that_every_client_decodes() {
    let mut position = Map::new();
    position.insert("partitionId", Value::Number(0.0));
    position.insert("seqNo", Value::Number(300.0));
    let mut message = Map::new();
    message.insert("type", Value::String("ack".into()));
    message.insert("positions", Value::Array(vec![Value::Object(position)]));
    message.insert("vector", Value::Bytes(vec![0, 0, 128, 63]));
    message.insert("ratio", Value::Number(0.5));
    let expected: Vec<u8> = [
        &[0x84, 0xa4][..],
        b"type",
        &[0xa3],
        b"ack",
        &[0xa9],
        b"positions",
        &[0x91, 0x82, 0xab],
        b"partitionId",
        &[0x00, 0xa5],
        b"seqNo",
        &[0xcd, 0x01, 0x2c, 0xa6],
        b"vector",
        &[0xc4, 0x04, 0, 0, 128, 63, 0xa5],
        b"ratio",
        &[0xcb, 0x3f, 0xe0, 0, 0, 0, 0, 0, 0],
    ]
    .concat();
    let encoded = encode_msgpack(&Value::Object(message.clone())).expect("the message encodes");
    assert_eq!(encoded, expected);
    assert_eq!(
        decode_msgpack(&expected).expect("the bytes decode"),
        Value::Object(message)
    );
}

#[test]
fn hostile_bytes_fail_to_decode_without_a_panic() {
    let mut nested = vec![0x91u8; 101];
    nested.push(0xc0);
    let hostile: [&[u8]; 6] = [
        &[],
        &[0xc1],
        &[0xdd, 0xff, 0xff, 0xff, 0xff],
        &[0xdf, 0xff, 0xff, 0xff, 0xff, 0xa1, b'k'],
        &[0x81, 0xa1, b'k', 0xc0, 0xc0],
        &nested,
    ];
    for bytes in hostile {
        let refused = decode_msgpack(bytes).expect_err("hostile bytes fail to decode");
        assert_eq!(
            refused.code(),
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "{bytes:?}"
        );
    }
}
