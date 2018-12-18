pragma solidity 0.4.24;
import "../common/SecuredTokenTransfer.sol";
import "./Proxy.sol";

/// @title Paying Proxy - Generic proxy contract allows to execute all transactions applying the code of a master contract.
/// And sends funds after creation to a specified account.
/// @author Stefan George - <stefan@gnosis.pm>
/// @author Richard Meissner - <richard@gnosis.pm>
/// @author Andrew Redden - <andrew@groundhog.network>
contract PayingProxy is Proxy, SecuredTokenTransfer {

    /// @dev Constructor function sets address of master copy contract.
    /// @param _masterCopy Master copy address.
    /// @param funder Address that should be paid for the execution of this call
    /// @param paymentToken Token that should be used for the payment (0 is ETH)
    /// @param payment Value that should be paid
    constructor(address _masterCopy, address funder, address paymentToken, uint256 payment)
        Proxy(_masterCopy)
        public
    {
        if (payment > 0) {
            if (paymentToken == address(0)) {
                 // solium-disable-next-line security/no-send
                require(funder.send(payment), "Could not pay safe creation with ether");
            } else {
                require(transferToken(paymentToken, funder, payment), "Could not pay safe creation with token");
            }
        } 
    }
}
