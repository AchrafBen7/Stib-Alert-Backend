const multer = () => ({
    single: () => (req, res, next) => next(),
    array: () => (req, res, next) => next(),
    fields: () => (req, res, next) => next(),
    none: () => (req, res, next) => next(),
});
multer.diskStorage = () => ({});
multer.memoryStorage = () => ({});
module.exports = multer;
