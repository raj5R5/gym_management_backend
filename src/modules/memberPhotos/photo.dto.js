function photoFields(member) {
  if (!member.photoUrl || !member.photoPublicId) return member.photoRevision > 0 ? { photoRevision: member.photoRevision } : {};
  // Distribute only a scoped API path. Private provider URLs/IDs never need to
  // leave the backend; the image route reauthorizes every image read.
  return { photoUrl: `gyms/${member.gymId}/members/${member._id}/photo?v=${member.photoRevision ?? 0}`,
    photoRevision: member.photoRevision ?? 0 };
}
module.exports = { photoFields };
