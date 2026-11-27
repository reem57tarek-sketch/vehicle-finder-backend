const { ObjectId } = require("mongodb");
const publicFields = { _id: 1, full_name: 1, email: 1, phone_number: 1, is_email_verified: 1, created_at: 1 };
const emailOptions = { collation: { locale: "en", strength: 2 } };
function serialize(document) {
  if (!document) return undefined;
  const { _id, ...fields } = document;
  return { user_id: _id.toString(), ...fields };
}
function idFilter(id) { return typeof id === "string" && /^[a-f0-9]{24}$/i.test(id) ? { _id: new ObjectId(id) } : null; }
function createUserModel(database) {
  async function findId(id, projection) {
    const filter = idFilter(id);
    if (!filter) return undefined;
    return serialize(await (await database.users()).findOne(filter, { projection }));
  }
  async function update(filter, fields, projection = publicFields) {
    if (!filter) return undefined;
    return serialize(await (await database.users()).findOneAndUpdate(filter,
      { $set: { ...fields, updated_at: new Date() } },
      { returnDocument: "after", includeResultMetadata: false, projection }));
  }
  return {
    getUserById: (id) => findId(id, publicFields),
    async getUserByEmail(email) { return serialize(await (await database.users()).findOne({ email }, emailOptions)); },
    async createUser(data) {
      const document = { ...data, email: data.email.trim().toLowerCase(), phone_number: data.phone_number || null,
        is_email_verified: false, reset_token_hash: null, reset_token_expires: null, created_at: new Date(), updated_at: new Date() };
      const { insertedId } = await (await database.users()).insertOne(document);
      return findId(insertedId.toString(), publicFields);
    },
    verifyEmail: (hash) => update({ verification_token_hash: hash, verification_token_expires: { $gt: new Date() } },
      { is_email_verified: true, verification_token_hash: null, verification_token_expires: null },
      { _id: 1, full_name: 1, email: 1, is_email_verified: 1 }),
    async getUserForPasswordReset(email) { return serialize(await (await database.users()).findOne({ email },
      { ...emailOptions, projection: { _id: 1, email: 1 } })); },
    saveResetToken: (id, hash, expires) => update(idFilter(id), { reset_token_hash: hash, reset_token_expires: expires }, { _id: 1 }),
    resetPassword: (hash, passwordHash) => update({ reset_token_hash: hash, reset_token_expires: { $gt: new Date() } },
      { password_hash: passwordHash, reset_token_hash: null, reset_token_expires: null }, { _id: 1 }),
    updateUser: (id, name, phone) => update(idFilter(id), { ...(name == null ? {} : { full_name: name }), ...(phone == null ? {} : { phone_number: phone }) }),
    getPasswordHash: (id) => findId(id, { _id: 1, password_hash: 1 }),
    updatePassword: (id, hash, currentHash) => update(idFilter(id) ? { ...idFilter(id), password_hash: currentHash } : null,
      { password_hash: hash, reset_token_hash: null, reset_token_expires: null }, { _id: 1 }),
    saveVerificationToken: (id, hash, expires) => update(idFilter(id) ? { ...idFilter(id), is_email_verified: { $ne: true } } : null,
      { verification_token_hash: hash, verification_token_expires: expires }, { _id: 1 }),
  };
}
module.exports = { createUserModel };
