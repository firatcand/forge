export {
  QuestionChannelError,
  isNodeFsError,
  isQuestionChannelError,
  type QuestionChannelErrorCode,
  type QuestionChannelErrorDetails,
} from './errors.ts';
export {
  writeAnswerAtomic,
  writeQuestionAtomic,
  type WriteOptions,
} from './writer.ts';
export {
  readAnswer,
  readQuestion,
  type ReadOptions,
} from './reader.ts';
export {
  answerFilePath,
  attemptDir,
  attemptsDir,
  answersDir,
  legacyAnswersDir,
  legacyArchiveRoot,
  legacyArchiveSession,
  legacyQuestionsDir,
  questionFilePath,
  questionsDir,
  taskDir,
  tasksRootDir,
  validateIdSegment,
} from './paths.ts';
export {
  findAnsweredQuestionByDecisionKey,
  findOpenQuestionByDecisionKey,
  findQuestionFile,
  listOpenQuestionsAcrossTree,
  type AnsweredQuestionMatch,
  type DecisionKeyLookupOptions,
  type FindOptions,
  type QuestionLocation,
} from './lookup.ts';
