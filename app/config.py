"""Flask configuration classes for each deployment environment."""
# ColliBoy

import os


class Config:
    """Shared settings common to all environments."""
    UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # Cap uploads at 50 MB (ColliBoy)


class DevelopmentConfig(Config):
    """Local development settings; debugging enabled."""
    DEBUG = True


class ProductionConfig(Config):
    """Hardened production settings; debug disabled."""
    DEBUG = False


config_by_name = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig,
}
