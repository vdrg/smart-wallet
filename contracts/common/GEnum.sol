pragma solidity 0.4.24;


/// @title Enum - Collection of enums
/// @author Richard Meissner - <richard@gnosis.pm>
contract GEnum {
    enum SubscriptionStatus {
        INIT,
        VALID,
        CANCELLED,
        EXPIRED,
        PAYMENT_FAILED
    }

    enum Period {
        INIT,
        DAY,
        WEEK,
        MONTH
    }
}
