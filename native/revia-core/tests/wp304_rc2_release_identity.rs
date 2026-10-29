use revia_core::release::RELEASE_VERSION;

#[test]
fn rc2_release_identity_is_not_reused_from_the_published_rc1_candidate() {
    assert_eq!(RELEASE_VERSION, "1.0.0-rc.2.1");
}
