// Calendar labels, not elapsed milliseconds. Feb-29 birthdays reach 18 on March 1
// in non-leap years. The caller supplies the authorized gym's current date.
function requireAdultMember(dateOfBirth, today) {
  if (!dateOfBirth) return; // Missing DOB is unknown age, never verified adulthood.
  const birth = dateOfBirth instanceof Date ? dateOfBirth.toISOString().slice(0, 10) : dateOfBirth;
  const age = Number(today.slice(0, 4)) - Number(birth.slice(0, 4))
    - (today.slice(5) < birth.slice(5) ? 1 : 0);
  if (age < 18) {
    const error = new Error('Under-18 member workflow is unavailable.');
    error.code = 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE'; throw error;
  }
}
module.exports = { requireAdultMember };
