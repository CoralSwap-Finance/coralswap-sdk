#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_storage_bit_packing() {
        let created: u64 = 1718000000;
        let updated: u64 = 1718005000;
        assert!(updated > created);
    }
}
