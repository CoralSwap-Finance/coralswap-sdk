Context
Stop-loss order placement validates trigger price, amounts, and addresses via hand-written checks. Adopting the shared zod schema pattern (companion issue in this batch) here centralizes this module's input contract.

What to implement
Define a zod schema for stop-loss placement parameters
Replace the manual checks with schema validation, surfacing the SDK's existing ValidationError on failure
Confirm all existing validation rules are preserved exactly
Acceptance criteria
 Manual validation replaced by zod schema validation
 All existing validation test cases still pass with equivalent or better error messages
 No validation rule is silently dropped in the migration

